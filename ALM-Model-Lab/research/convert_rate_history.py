"""
Converter: research/data/Rate_History.xlsx -> public/rate_history_2008-10_<end>.json

Source workbook (owner-curated, protected -- never overwrite): month-end
observations from Oct 2008 with Fed Target, EFFR, overnight SOFR, a
17-tenor SOFR term curve (1M-360M), and a 17-tenor FHLB advance curve.
The history is trimmed to --end-month HERE, by filter -- never by editing
the workbook. Default end 2026-03 aligns with the 2026-03-31 market snapshot.

Conventions enforced here (must match src/math/rates/rateHistory.ts):
  - rates in DECIMAL per annum (workbook percent / 100), matching CurveQuote.rate;
  - tenors as integer months; the workbook's 'SOFR_48Y' header is a typo for 48M
    (values sit between 36M and 60M) and is normalized to 48;
  - months as ISO 'YYYY-MM' derived from the EndMonth column;
  - rates matrix indexed [monthIdx][tenorIdx].

Provenance: SOFR publication began April 2018; earlier 'SOFR' tenor values are
an OIS/EFFR-based proxy splice (per Chih, 2026-06-09). Recorded in the metadata
block so the UI can label the proxied era.

Run:  py research/convert_rate_history.py
      py research/convert_rate_history.py --end-month 2026-05
"""
from __future__ import annotations

import argparse
import json
import os

import openpyxl

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "data", "Rate_History.xlsx")
DEFAULT_END_MONTH = "2026-03"

SOFR_TENORS = [1, 3, 6, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 180, 240, 300, 360]
FHLB_TENORS = [1, 3, 6, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 180, 240, 300, 360]

# Workbook header -> (series, tenor). 'SOFR_48Y' is the known 48M typo.
def sofr_header(tenor: int) -> str:
    return "SOFR_48Y" if tenor == 48 else f"SOFR_{tenor}M"


def dec(value: float) -> float:
    """Percent -> decimal, rounded to 1e-7 (0.001 bp) to keep the JSON compact."""
    return round(value / 100.0, 7)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--end-month",
        default=DEFAULT_END_MONTH,
        help="last month to include, YYYY-MM (trim by filter, never edit the workbook)",
    )
    args = ap.parse_args()
    end_year, end_mo = (int(p) for p in args.end_month.split("-"))
    out_path = os.path.join(HERE, "..", "public", f"rate_history_2008-10_{args.end_month}.json")

    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb["Rate_History"]
    rows = list(ws.iter_rows(values_only=True))
    header = {name: idx for idx, name in enumerate(rows[0])}
    data = rows[1:]

    months: list[str] = []
    fed_target: list[float] = []
    effr: list[float] = []
    sofr_on: list[float] = []
    sofr_rates: list[list[float]] = []
    fhlb_rates: list[list[float]] = []

    prev = None
    for row in data:
        d = row[header["EndMonth"]]
        if (d.year, d.month) > (end_year, end_mo):
            continue
        if prev is not None and (d.year - prev.year) * 12 + (d.month - prev.month) != 1:
            raise ValueError(f"month gap between {prev} and {d}")
        prev = d
        months.append(f"{d.year:04d}-{d.month:02d}")
        fed_target.append(dec(row[header["Fed Target"]]))
        effr.append(dec(row[header["FEFF_1D"]]))
        sofr_on.append(dec(row[header["SOFR_1D"]]))
        sofr_rates.append([dec(row[header[sofr_header(k)]]) for k in SOFR_TENORS])
        fhlb_rates.append([dec(row[header[f"FHLB_{k}M"]]) for k in FHLB_TENORS])

    n = len(months)
    out = {
        "name": "Model Sense rate history",
        "start_month": months[0],
        "end_month": months[-1],
        "months": n,
        "units": "decimal_per_annum",
        "observation": "month_end",
        "provenance": {
            "source_workbook": "research/data/Rate_History.xlsx (owner-curated, 2026-06)",
            "sofr_note": (
                "SOFR publication began Apr 2018; earlier SOFR tenor values are an "
                "OIS/EFFR-based proxy splice."
            ),
            "fhlb_note": "FHLB advance rates, month-end offered levels.",
            "generated_by": "research/convert_rate_history.py",
        },
        "fed_target": fed_target,
        "effr": effr,
        "sofr_on": sofr_on,
        "sofr_term": {"tenors_months": SOFR_TENORS, "rates": sofr_rates},
        "fhlb_term": {"tenors_months": FHLB_TENORS, "rates": fhlb_rates},
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"wrote {os.path.abspath(out_path)}: {n} months, {size_kb:.0f} KB")
    print(f"range {months[0]} .. {months[-1]}")


if __name__ == "__main__":
    main()
