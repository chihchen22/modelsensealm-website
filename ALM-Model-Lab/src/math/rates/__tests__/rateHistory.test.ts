import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  firstCompleteIndex,
  loadRateHistory,
  parseRateHistory,
  trailingMA,
  trailingMASeries,
} from "../rateHistory";

const HISTORY_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "public",
  "rate_history_2008-10_2026-03.json",
);

describe("rateHistory dataset", () => {
  it("loads 210 continuous months Oct 2008 - Mar 2026", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    expect(h.months.length).toBe(210);
    expect(h.months[0]).toBe("2008-10");
    expect(h.months[209]).toBe("2026-03");
    expect(h.indexOfMonth("2008-10")).toBe(0);
    expect(h.indexOfMonth("2026-03")).toBe(209);
    expect(h.indexOfMonth("2026-05")).toBe(-1);
    expect(h.indexOfMonth("2008-09")).toBe(-1);
    expect(h.tenorsMonths).toEqual([
      1, 3, 6, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 180, 240, 300, 360,
    ]);
  });

  it("matches workbook spot values (decimal per annum)", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    // Oct 2008 row: Fed Target 1%, EFFR 0.22%, O/N SOFR 0.30%, SOFR 12M 1.0571%,
    // SOFR 48M ('SOFR_48Y' typo column) 2.9237%, FHLB 1M 1.96%.
    expect(h.fedTarget[0]).toBeCloseTo(0.01, 9);
    expect(h.effr[0]).toBeCloseTo(0.0022, 9);
    expect(h.sofrON[0]).toBeCloseTo(0.003, 9);
    expect(h.sofrTermRate(0, 12)).toBeCloseTo(0.010571, 9);
    expect(h.sofrTermRate(0, 48)).toBeCloseTo(0.029237, 9);
    expect(h.fhlbTermRate(0, 1)).toBeCloseTo(0.0196, 9);
    // Dec 2008: Fed Target cut to 0.25%.
    expect(h.fedTarget[2]).toBeCloseTo(0.0025, 9);
    // Mar 2026 row: SOFR 12M 3.70095%, FHLB 360M 5.48% (matches the
    // 2026-03-31 market snapshot to the basis point; verified at conversion).
    expect(h.sofrTermRate(209, 12)).toBeCloseTo(0.0370095, 9);
    expect(h.fhlbTermRate(209, 360)).toBeCloseTo(0.0548, 9);
  });

  it("interpolates linearly in tenor and clamps at the ends", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const mid = (h.sofrTermRate(0, 12) + h.sofrTermRate(0, 24)) / 2;
    expect(h.sofrTermRate(0, 18)).toBeCloseTo(mid, 12);
    expect(h.sofrTermRate(0, 0.5)).toBeCloseTo(h.sofrTermRate(0, 1), 12);
    expect(h.sofrTermRate(0, 999)).toBeCloseTo(h.sofrTermRate(0, 360), 12);
  });

  it("rejects malformed inputs loudly", async () => {
    const raw = JSON.parse(await readFile(HISTORY_PATH, "utf-8"));
    const truncated = { ...raw, effr: raw.effr.slice(0, 100) };
    expect(() => parseRateHistory(truncated)).toThrow(/effr has 100 entries/);
    const badEnd = { ...raw, end_month: "2026-06" };
    expect(() => parseRateHistory(badEnd)).toThrow(/end_month/);
    const badTenor = {
      ...raw,
      sofr_term: { ...raw.sofr_term, tenors_months: [...raw.sofr_term.tenors_months] },
    };
    badTenor.sofr_term.tenors_months[1] = 1; // duplicate of node 0
    expect(() => parseRateHistory(badTenor)).toThrow(/strictly increasing/);
  });
});

describe("trailing MA (inclusive window)", () => {
  it("is NaN before the first complete window and exact at it", () => {
    const v = [1, 2, 3, 4, 5, 6];
    expect(trailingMA(v, 1, 3)).toBeNaN();
    expect(trailingMA(v, 2, 3)).toBeCloseTo(2, 12); // mean(1,2,3)
    expect(trailingMA(v, 5, 3)).toBeCloseTo(5, 12); // mean(4,5,6)
    expect(firstCompleteIndex(3)).toBe(2);
  });

  it("trailingMASeries agrees with pointwise trailingMA", () => {
    const v = Array.from({ length: 40 }, (_, i) => Math.sin(i) + 2);
    const s = trailingMASeries(v, 12);
    for (let i = 0; i < v.length; i++) {
      if (i < 11) {
        expect(s[i]).toBeNaN();
      } else {
        expect(s[i]).toBeCloseTo(trailingMA(v, i, 12), 12);
      }
    }
  });

  it("pillar first-complete months match the dataset (12M -> 2009-09, 120M -> 2018-09)", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    expect(h.months[firstCompleteIndex(12)]).toBe("2009-09");
    expect(h.months[firstCompleteIndex(120)]).toBe("2018-09");
    expect(h.months[firstCompleteIndex(180)]).toBe("2023-09");
  });

  it("pillarYield is the trailing k-MA of the k-month tenor (tractor identity)", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const k = 12;
    const series12 = h.sofrTermSeries(k);
    const last = h.months.length - 1;
    let sum = 0;
    for (let j = last - k + 1; j <= last; j++) sum += series12[j];
    expect(h.pillarYield(last, k)).toBeCloseTo(sum / k, 12);
    // Incomplete window before Sep 2009.
    expect(h.pillarYield(5, k)).toBeNaN();
    // As-of the 2025-09 calibration date the 12M pillar carries the trailing
    // year of 12M rates; sanity-bound it between the min and max of its window.
    const asOf = h.indexOfMonth("2025-09");
    const win = series12.slice(asOf - k + 1, asOf + 1);
    const y = h.pillarYield(asOf, k);
    expect(y).toBeGreaterThanOrEqual(Math.min(...win));
    expect(y).toBeLessThanOrEqual(Math.max(...win));
  });
});
