/**
 * ALM analytics types for the ALM Model Lab.
 *
 * Phase 4: gap views read cashflows directly (per-instrument, monthly), so
 * there are no shared bucket types. FTP is decomposed into interest-rate FTP,
 * liquidity-premium FTP, and all-in FTP via match-funding against the
 * SOFR + TLP curve.
 */

/** Monthly coupon-vs-FTP series row (per instrument). */
export interface FtpMonthlyRow {
  month: number;
  /** Realised coupon at this month (constant for fixed; floating for floater). */
  couponRate: number;
  /** Spot funding rate at this month (constant for fixed = par-matched all-in;
   *  floating for floater = SOFR forward + TLP at the reset tenor). */
  ftpRate: number;
}

/** Per-instrument FTP decomposition. */
export interface FtpInstrumentRow {
  instrumentId: string;
  label: string;
  /** Balance-sheet side. Drives the FTP-margin sign convention. */
  side: "asset" | "liability";
  /** Balance-weighted realised coupon over the instrument's life. For assets
   *  this is the asset rate (yield earned); for liabilities it is the deposit
   *  rate (cost paid). */
  assetRate: number;
  /** Par-matched FTP against the SOFR zero curve alone. */
  irFtpRate: number;
  /** Liquidity-premium piece, residual = allInFtpRate - irFtpRate. */
  lpFtpRate: number;
  /** Par-matched FTP against the (SOFR + TLP) all-in funding curve. */
  allInFtpRate: number;
  /** Positive franchise value:
   *  - asset:     assetRate − allInFtpRate (locked NIM under match-funding)
   *  - liability: allInFtpRate − assetRate (deposit-franchise FTP credit) */
  ftpMargin: number;
  /** Monthly time series for the coupon-vs-FTP visualization. */
  monthlySeries: FtpMonthlyRow[];
}

export interface FTPResult {
  perInstrument: FtpInstrumentRow[];
  /** Notional-weighted FTP margin across the book. */
  bookNim: number;
}
