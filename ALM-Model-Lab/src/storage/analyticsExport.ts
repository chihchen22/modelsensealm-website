/**
 * Excel export for Repricing Gap, Liquidity Gap, and FTP analytics.
 *
 * Each builder produces a single .xlsx with one tab per selected instrument
 * plus (where applicable) a Summary or Curves tab. The data is the same
 * series rendered in the corresponding UI tab, so users can audit / chart
 * against the in-app views.
 */

import { utils, write } from "xlsx";

import type { Cashflow } from "../math/instruments/types";
import type { FtpInstrumentRow } from "../math/analytics/types";
import type { ZeroCurve } from "../math/rates/bootstrap";
import type { TLPCurve } from "../math/rates/tlpCurve";

export interface InstrumentSeries {
  /** Display label, used as the sheet name (truncated to 31 chars per Excel). */
  label: string;
  cashflows: ReadonlyArray<Cashflow>;
  notional: number;
  side: "asset" | "liability";
  /** Optional β at t=0 for IB-NMD style instruments — drives the rate-locked
   *  outstanding column when present. */
  initialBeta?: number;
  /** Set true when the instrument fully reprices on the first reset (floater). */
  isFloater?: boolean;
}

function safeSheetName(name: string): string {
  // Excel: max 31 chars, no \ / ? * [ ] :
  return name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
}

function finalize(wb: ReturnType<typeof utils.book_new>): Uint8Array {
  const data = write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(data);
}

/* -------------------------------------------------------------------------- */
/* Repricing gap                                                              */
/* -------------------------------------------------------------------------- */

function repricingRows(s: InstrumentSeries): unknown[][] {
  const header = [
    "Month",
    "Total balance ($)",
    "Outstanding rate-locked ($)",
    "Periodic repricing ($)",
  ];
  const rows: unknown[][] = [header];
  const beta = Math.max(0, Math.min(1, s.initialBeta ?? 0));
  s.cashflows.forEach((c, i) => {
    let outstanding: number;
    let periodic: number;
    if (s.isFloater) {
      // Entire notional reprices on first reset.
      outstanding = i === 0 ? s.notional : 0;
      periodic = i === 0 ? s.notional : 0;
    } else if (s.initialBeta !== undefined) {
      // NMD repricing split: full notional at month 1; (1 − β)·balance after.
      outstanding = i === 0 ? s.notional : c.balance * (1 - beta);
      periodic = i === 0 ? beta * s.notional : 0;
    } else {
      outstanding = c.balance;
      periodic = c.principalPaid;
    }
    rows.push([c.monthOffset, c.balance, outstanding, periodic]);
  });
  return rows;
}

export function buildRepricingGapWorkbook(
  series: ReadonlyArray<InstrumentSeries>,
): Uint8Array {
  const wb = utils.book_new();
  if (series.length === 0) {
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet([["No instruments selected"]]),
      "Empty",
    );
    return finalize(wb);
  }
  // Summary across selected instruments — outstanding rate-locked at t=0 and
  // total periodic repricing in month 1 (the largest single repricing event
  // for floaters / IB NMD).
  const summary: unknown[][] = [
    ["Instrument", "Side", "Notional ($)", "Outstanding(0) ($)", "Periodic(month 1) ($)"],
  ];
  for (const s of series) {
    const rows = repricingRows(s);
    // rows[0] is header, rows[1] = month 1.
    const m1 = rows[1] as Array<unknown>;
    summary.push([s.label, s.side, s.notional, m1[2] ?? 0, m1[3] ?? 0]);
  }
  utils.book_append_sheet(wb, utils.aoa_to_sheet(summary), "Summary");
  for (const s of series) {
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet(repricingRows(s)),
      safeSheetName(s.label),
    );
  }
  return finalize(wb);
}

/* -------------------------------------------------------------------------- */
/* Liquidity gap                                                              */
/* -------------------------------------------------------------------------- */

function liquidityRows(s: InstrumentSeries): unknown[][] {
  const header = [
    "Month",
    "Outstanding principal ($)",
    "Principal received ($)",
    "Interest paid ($)",
    "Coupon rate (decimal)",
  ];
  const rows: unknown[][] = [header];
  for (const c of s.cashflows) {
    rows.push([c.monthOffset, c.balance, c.principalPaid, c.interestPaid, c.couponRate]);
  }
  return rows;
}

function walYears(cf: ReadonlyArray<Cashflow>): number {
  let num = 0;
  let den = 0;
  for (const c of cf) {
    num += (c.monthOffset / 12) * c.principalPaid;
    den += c.principalPaid;
  }
  return den > 1e-12 ? num / den : 0;
}

export function buildLiquidityGapWorkbook(
  series: ReadonlyArray<InstrumentSeries>,
): Uint8Array {
  const wb = utils.book_new();
  if (series.length === 0) {
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet([["No instruments selected"]]),
      "Empty",
    );
    return finalize(wb);
  }
  const summary: unknown[][] = [
    ["Instrument", "Side", "Notional ($)", "WAL (years)", "Months projected"],
  ];
  for (const s of series) {
    summary.push([
      s.label,
      s.side,
      s.notional,
      walYears(s.cashflows),
      s.cashflows.length,
    ]);
  }
  utils.book_append_sheet(wb, utils.aoa_to_sheet(summary), "Summary");
  for (const s of series) {
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet(liquidityRows(s)),
      safeSheetName(s.label),
    );
  }
  return finalize(wb);
}

/* -------------------------------------------------------------------------- */
/* FTP                                                                        */
/* -------------------------------------------------------------------------- */

const FTP_CURVE_TENORS_YEARS = [
  1 / 12, 3 / 12, 6 / 12, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10,
  12, 15, 18, 20, 25, 30,
];

function curveTable(curve: ZeroCurve, tlp: TLPCurve): unknown[][] {
  const header = [
    "Tenor (years)",
    "SOFR zero (decimal)",
    "TLP (decimal)",
    "TLP (bps)",
    "All-in SOFR + TLP (decimal)",
  ];
  const rows: unknown[][] = [header];
  for (const t of FTP_CURVE_TENORS_YEARS) {
    const sofr = curve.zeroRate(t);
    const lp = tlp.tlp(t);
    rows.push([t, sofr, lp, lp * 1e4, sofr + lp]);
  }
  return rows;
}

function ftpInstrumentRows(row: FtpInstrumentRow): unknown[][] {
  const header = ["Month", "Coupon rate (decimal)", "All-in FTP rate (decimal)", "FTP margin (decimal)"];
  const rows: unknown[][] = [header];
  const sign = row.side === "liability" ? -1 : 1;
  for (const m of row.monthlySeries) {
    const margin = sign * (m.couponRate - m.ftpRate);
    rows.push([m.month, m.couponRate, m.ftpRate, margin]);
  }
  return rows;
}

export interface FtpExportInputs {
  perInstrument: ReadonlyArray<FtpInstrumentRow>;
  bookNim: number;
  curve: ZeroCurve;
  tlp: TLPCurve;
  /** Filter: only include FtpInstrumentRow whose `instrumentId` is in this set. */
  selectedIds: ReadonlyArray<string>;
}

export function buildFtpWorkbook(inputs: FtpExportInputs): Uint8Array {
  const { perInstrument, bookNim, curve, tlp, selectedIds } = inputs;
  const wb = utils.book_new();
  const idSet = new Set(selectedIds);
  const selected = perInstrument.filter((r) => idSet.has(r.instrumentId));

  // Summary tab — per-instrument decomposition + book NIM.
  const summary: unknown[][] = [
    ["Notional-weighted FTP margin (decimal)", bookNim],
    ["Notional-weighted FTP margin (bps)", bookNim * 1e4],
    [],
    [
      "Instrument",
      "Side",
      "Coupon (decimal)",
      "IR FTP",
      "LP FTP",
      "All-in FTP",
      "FTP margin",
      "FTP margin (bps)",
    ],
  ];
  for (const r of selected) {
    summary.push([
      r.label,
      r.side,
      r.assetRate,
      r.irFtpRate,
      r.lpFtpRate,
      r.allInFtpRate,
      r.ftpMargin,
      r.ftpMargin * 1e4,
    ]);
  }
  utils.book_append_sheet(wb, utils.aoa_to_sheet(summary), "Summary");

  utils.book_append_sheet(wb, utils.aoa_to_sheet(curveTable(curve, tlp)), "Curves");

  for (const r of selected) {
    utils.book_append_sheet(
      wb,
      utils.aoa_to_sheet(ftpInstrumentRows(r)),
      safeSheetName(r.label),
    );
  }
  return finalize(wb);
}

/* -------------------------------------------------------------------------- */
/* Curve (bootstrapped zero / forward / discount)                            */
/* -------------------------------------------------------------------------- */

export interface CurveExportInputs {
  curve: ZeroCurve;
  /** Forward tenor in years (e.g. 1.0 for 1Y forward). */
  forwardTenor: number;
  tlp: TLPCurve;
}

const ACT_360_ANNUAL_CURVE = 365 / 360;

function allInForwardSwap(
  dfAI: (u: number) => number,
  t1: number,
  t2: number,
): number {
  const tau = t2 - t1;
  if (tau <= 1.0 + 1e-9) return (dfAI(t1) / dfAI(t2) - 1) / tau;
  const n = Math.round(tau);
  let annuity = 0;
  for (let k = 1; k <= n; k++) annuity += ACT_360_ANNUAL_CURVE * dfAI(t1 + k);
  return (dfAI(t1) - dfAI(t1 + n)) / annuity;
}

export function buildCurveWorkbook(inputs: CurveExportInputs): Uint8Array {
  const { curve, forwardTenor, tlp } = inputs;
  const wb = utils.book_new();
  const isSwap = forwardTenor > 1.0 + 1e-9;
  const fKind = isSwap ? "swap" : "forward";
  const fLabel = `τ=${forwardTenor < 1 ? forwardTenor.toFixed(4) : forwardTenor}Y`;
  const header = [
    "Year",
    // SOFR
    "SOFR zero (decimal)",
    "SOFR zero (%)",
    `SOFR ${fKind} ${fLabel} (decimal)`,
    `SOFR ${fKind} ${fLabel} (%)`,
    "SOFR discount factor",
    // All-in FTP (SOFR + TLP)
    "All-in zero (decimal)",
    "All-in zero (%)",
    `All-in ${fKind} ${fLabel} (decimal)`,
    `All-in ${fKind} ${fLabel} (%)`,
    "All-in discount factor",
    // TLP spread
    "TLP spread (decimal)",
    "TLP spread (bps)",
  ];
  const rows: unknown[][] = [header];
  const dfAI = (u: number) => Math.exp(-(curve.zeroRate(u) + tlp.tlp(u)) * u);
  for (let m = 1; m <= 360; m++) {
    const t = m / 12;
    const z = curve.zeroRate(t);
    const fwd = curve.forwardSwapRate(t, t + forwardTenor);
    const df = curve.discountFactor(t);
    const spread = tlp.tlp(t);
    const zAI = z + spread;
    const fwdAI = allInForwardSwap(dfAI, t, t + forwardTenor);
    const dfAIt = dfAI(t);
    rows.push([
      parseFloat(t.toFixed(6)),
      parseFloat(z.toFixed(8)),
      parseFloat((z * 100).toFixed(6)),
      parseFloat(fwd.toFixed(8)),
      parseFloat((fwd * 100).toFixed(6)),
      parseFloat(df.toFixed(8)),
      parseFloat(zAI.toFixed(8)),
      parseFloat((zAI * 100).toFixed(6)),
      parseFloat(fwdAI.toFixed(8)),
      parseFloat((fwdAI * 100).toFixed(6)),
      parseFloat(dfAIt.toFixed(8)),
      parseFloat(spread.toFixed(8)),
      parseFloat((spread * 1e4).toFixed(4)),
    ]);
  }
  utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), "Curve");
  return finalize(wb);
}

/* -------------------------------------------------------------------------- */
/* Browser download helper                                                    */
/* -------------------------------------------------------------------------- */

export function downloadXlsx(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
