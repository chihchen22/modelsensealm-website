import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  isDefaultCalibrationSwaption,
  isDefaultDisplayCap,
  loadMarketSnapshot,
} from "../marketData";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

describe("curated display subsets (SABR-tab grids)", () => {
  it("curated cap grid is 6 expiries x (ATM + 7 strikes) = 48 quotes on the 3/31 export", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curated = snap.capQuotes.filter(isDefaultDisplayCap);
    expect(snap.capQuotes.length).toBe(390); // 15 expiries x (25 strikes + ATM)
    expect(curated.length).toBe(48);
    const expiries = new Set(curated.map((q) => q.expiryYears));
    expect([...expiries].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 10, 15]);
    // Each curated expiry carries its ATM quote.
    expect(curated.filter((q) => q.isAtm).length).toBe(6);
  });

  it("curated swaption grid equals the 28-quote default calibration subset on the 3/31 export", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curated = snap.swaptionATMQuotes.filter(isDefaultCalibrationSwaption);
    expect(snap.swaptionATMQuotes.length).toBe(315); // 21 expiries x 15 tenors
    expect(curated.length).toBe(28); // 7 expiries x 4 tenors
  });
});
