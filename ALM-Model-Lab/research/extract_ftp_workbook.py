"""
Extractor: Static_Strip_FTP_example_BBG_YC.xlsm -> research/data/ftp_workbook_extract.json

Dumps the four loan sheets of the owner's static-strip FTP workbook (cached
values; the loan schedules were last calculated on the 2025-09 BBG strip even
though the workbook's BBG_Curves sheets carry 2026-03-31) so the FTP parity
harness (research/ftp_parity_check.ts) can replicate the sheet math without
re-reading the xlsm.

Per sheet: assumptions, the FTP results block (IR_FTP / All-in_FTP / TLP /
Loan Coupon), and the monthly schedule incl. the sheet's own ACT/365 day-count
fractions and dated RFR / all-in discount factors.

Run:  py research/extract_ftp_workbook.py
"""
from __future__ import annotations

import json
import os

import openpyxl

SRC = r"C:\Users\deech\Downloads\Static_Strip_FTP_example_BBG_YC.xlsm"
OUT = os.path.join(os.path.dirname(__file__), "data", "ftp_workbook_extract.json")

SHEETS = [
    "Fixed_Rate_Loan",
    "Fixed_Rate_Loan_amort",
    "Floating_Rate_Loan",
    "Floating_Rate_Loan_Prime",
]

# 1-indexed columns of the monthly schedule (header on row 8, data from row 9).
COLS = {
    "month": 2, "date": 3, "balance": 4, "coupon": 5, "payment": 6,
    "interest": 7, "scheduled": 8, "maturity": 9, "cpr": 10, "smm": 11,
    "prepay": 12, "total_principal": 13, "dcf": 14, "rfr_df": 19, "allin_df": 25,
}
RESULT_LABEL_COL = 28  # 'IR_FTP' / 'All-in_FTP' / 'TLP' / 'Loan Coupon'
RESULT_VALUE_COL = 29


def main() -> None:
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    out: dict = {"source": os.path.basename(SRC), "sheets": {}}

    for name in SHEETS:
        ws = wb[name]
        grid = list(ws.iter_rows(values_only=True))

        def cell(r: int, c: int):
            row = grid[r - 1]
            return row[c - 1] if c <= len(row) else None

        assumptions = {
            "param_label": cell(2, 1),
            "param_value": cell(2, 5),
            "term_months": cell(3, 5),
            "cpr": cell(4, 5),
            "amort_type": "level-pay" if (cell(5, 5) or 0) >= 0.5 else "bullet",
        }
        results = {}
        for r in range(9, 13):
            label = cell(r, RESULT_LABEL_COL)
            if label is not None:
                results[str(label)] = cell(r, RESULT_VALUE_COL)

        rows = []
        r = 9
        while r <= len(grid):
            m = cell(r, COLS["month"])
            if not isinstance(m, (int, float)) or m < 1:
                break
            d = cell(r, COLS["date"])
            rows.append({
                "month": int(m),
                "date": d.strftime("%Y-%m-%d") if d is not None else None,
                "balance": cell(r, COLS["balance"]),
                "coupon": cell(r, COLS["coupon"]),
                "interest": cell(r, COLS["interest"]),
                "scheduled": cell(r, COLS["scheduled"]) or 0,
                "maturity": cell(r, COLS["maturity"]) or 0,
                "prepay": cell(r, COLS["prepay"]) or 0,
                "total_principal": cell(r, COLS["total_principal"]) or 0,
                "dcf": cell(r, COLS["dcf"]),
                "rfr_df": cell(r, COLS["rfr_df"]),
                "allin_df": cell(r, COLS["allin_df"]),
            })
            r += 1

        out["sheets"][name] = {"assumptions": assumptions, "results": results, "rows": rows}
        print(f"{name}: {len(rows)} months, results {results}")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {os.path.abspath(OUT)} ({os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
