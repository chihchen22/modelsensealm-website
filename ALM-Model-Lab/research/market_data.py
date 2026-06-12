"""Market-data loader for the ALM Model Lab Python reference.

Loads the canonical 9/30/2025 SOFR OIS curve plus cap and ATM swaption vol
surfaces from JSON. Exposes them as numpy arrays / dataclasses for the
calibration and pricing modules.

Reference: `data/market_2025-09-30.json`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
import numpy as np


@dataclass(frozen=True)
class CurveQuote:
    term: str
    t_years: float
    instrument_type: str  # "CASH" or "SWAP"
    rate: float


@dataclass(frozen=True)
class SwaptionATMQuote:
    expiry_years: float
    tenor_years: float
    normal_vol: float


@dataclass(frozen=True)
class CapQuote:
    expiry_years: float
    strike: float | None  # None for ATM
    normal_vol: float
    is_atm: bool


@dataclass(frozen=True)
class MarketSnapshot:
    calibration_date: str
    currency: str
    discounting_index: str
    curve_quotes: tuple[CurveQuote, ...]
    cap_quotes: tuple[CapQuote, ...]
    swaption_atm_quotes: tuple[SwaptionATMQuote, ...]


_TENOR_TO_YEARS = {
    "1D": 1 / 360,
    "1M": 1 / 12,
    "2M": 2 / 12,
    "3M": 3 / 12,
    "6M": 6 / 12,
    "9M": 9 / 12,
    "1Y": 1.0,
    "18M": 1.5,
    "2Y": 2.0,
    "3Y": 3.0,
    "4Y": 4.0,
    "5Y": 5.0,
    "6Y": 6.0,
    "7Y": 7.0,
    "8Y": 8.0,
    "9Y": 9.0,
    "10Y": 10.0,
    "12Y": 12.0,
    "15Y": 15.0,
    "20Y": 20.0,
    "25Y": 25.0,
    "30Y": 30.0,
}


def _to_years(label: str) -> float:
    return _TENOR_TO_YEARS[label]


def load_market_snapshot(path: str | Path) -> MarketSnapshot:
    """Load the JSON market snapshot at *path* and return a MarketSnapshot."""
    path = Path(path)
    with path.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)

    curve = tuple(
        CurveQuote(
            term=q["term"],
            t_years=float(q["t_years"]),
            instrument_type=q["type"],
            rate=float(q["rate"]),
        )
        for q in raw["curve_sofr_ois"]["instruments"]
    )

    caps: list[CapQuote] = []
    for row in raw["cap_vol_surface"]["rows"]:
        expiry = _to_years(row["expiry"])
        for strike_label, vol in row["vols"].items():
            is_atm = strike_label == "ATM"
            strike = None if is_atm else float(strike_label)
            caps.append(
                CapQuote(
                    expiry_years=expiry,
                    strike=strike,
                    normal_vol=float(vol),
                    is_atm=is_atm,
                )
            )

    swaptions: list[SwaptionATMQuote] = []
    for row in raw["swaption_atm_vol_surface"]["rows"]:
        expiry = _to_years(row["expiry"])
        for tenor_label, vol in row["vols"].items():
            swaptions.append(
                SwaptionATMQuote(
                    expiry_years=expiry,
                    tenor_years=_to_years(tenor_label),
                    normal_vol=float(vol),
                )
            )

    return MarketSnapshot(
        calibration_date=raw["calibration_date"],
        currency=raw["currency"],
        discounting_index=raw["discounting_index"],
        curve_quotes=curve,
        cap_quotes=tuple(caps),
        swaption_atm_quotes=tuple(swaptions),
    )


def curve_arrays(snapshot: MarketSnapshot) -> tuple[np.ndarray, np.ndarray]:
    """Return (t_years, par_rate) arrays from the curve quotes."""
    t = np.array([q.t_years for q in snapshot.curve_quotes])
    r = np.array([q.rate for q in snapshot.curve_quotes])
    return t, r


if __name__ == "__main__":
    snap = load_market_snapshot(
        Path(__file__).parent / "data" / "market_2025-09-30.json"
    )
    print(f"calibration_date: {snap.calibration_date}")
    print(f"curve points: {len(snap.curve_quotes)}")
    print(f"cap quotes:   {len(snap.cap_quotes)}")
    print(f"swpn quotes:  {len(snap.swaption_atm_quotes)}")
