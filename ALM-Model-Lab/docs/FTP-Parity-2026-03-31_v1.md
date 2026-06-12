# FTP Static-Strip Parity: Lab vs BBG Workbook (v1)

Date: 2026-06-10. Harness: `research/ftp_parity_check.ts` (run `npx tsx research/ftp_parity_check.ts`).
Inputs: `research/data/ftp_workbook_extract.json` (from `research/extract_ftp_workbook.py`,
reading `Static_Strip_FTP_example_BBG_YC.xlsm`) and `research/data/market_2026-03-31.json`.

## Headline

The workbook's FTP calculation is the same linear par-match as `ftp.ts`:
replicating the sheet's formula from its own cashflows, day-count fractions, and
dated discount factors reproduces the sheet's IR FTP and all-in FTP to 0.00 bp
on the 24M fixed bullet. All remaining differences are conventions, quantified
below; none indicate a math defect on either side.

## Vintage finding (matters for any future workbook comparison)

The workbook is internally split across two market vintages. Its BBG curve
sheets (`BBG_Curves_Values`) carry the 2026-03-31 strip, but the four loan
sheets' cached schedules were last calculated on the 2025-09 strip: the
floating sheet's month-1 1M SOFR reset is 4.2738% (the 9/30 level; 3/31 is
3.661%), the reset path m1..m5 traces the 2025-26 Fed cuts, and the cached
monthly discount factors imply a ~4.3% short rate. Consequently the sheet's
FTP results are September numbers (fixed-24M IR FTP 3.3901% = the September 2Y
par rate). The parity harness therefore never mixes vintages: it checks the
formula and mechanics workbook-internally, and reports the lab's 2026-03-31
numbers as a separate reference, not as a 1:1 comparison.

## Layer results

**A. Formula parity (workbook-internal).** Sheet par-match replicated from the
sheet's own columns: 24M bullet IR 3.3901% / all-in 3.7416%, both 0.00 bp from
the sheet's result cells. The 60M CPR-16.4% amortizer replicates to within
0.48 bp (IR) / 0.47 bp (all-in); the residual is consistent with cached-value
skew (result cells and schedule rows cached from different calc passes in the
stale workbook) and is not recoverable from cached values.

**B. Day-count quote basis.** The sheet accrues FTP income on ACT/365 dated
fractions; the lab quotes on month/12. Same cashflows, same discount factors:
the quote-basis effect is +0.39 bp (bullet) / +0.27 bp (amortizer) on the FTP
rate. Immaterial for teaching purposes; documented so nobody chases it later.

**C. Cashflow mechanics.** Lab instruments driven by each sheet's own coupon
path reproduce the schedules:

- 24M fixed bullet and 24M floating bullet: principal and balance exact;
  interest exact after normalizing the sheet's day-count fraction to /12
  (the sheets accrue interest as balance x coupon x dcf with dated fractions,
  e.g. ACT/360 Feb/Mar; raw gap up to 0.40 per 1,000 par in short months).
- 60M amortizer (CPR 16.4%) and 360M Prime (CPR 10%): level-pay re-amortized
  monthly on the remaining term, SMM = 1 - (1-CPR)^(1/12) on the
  post-scheduled balance, identical to `PrimeLoan`. Balance drift stays
  under 0.55% of par mid-schedule and converges; it is the compounding of the
  day-count interest difference through scheduled amortization, not a
  mechanics difference. Total principal returns par on both sides.

The floating sheets' result cells ("IR_FTP (1)") are month-1 spot quotes, not
par-matched constants; their exact accrual conversion is not recoverable from
cached values and is not needed: the lab's floater FTP convention (reset-window
forward + TLP at reset tenor) is documented in `ftp.ts`.

**D. Lab-native 2026-03-31 reference** (snapshot TLP from FHLB - SOFR;
curve 1M fwd 3.6609%, 2Y par 3.6210%):

| Loan | Coupon | IR FTP | LP FTP | All-in FTP | Margin |
|---|---|---|---|---|---|
| 24M 6% bullet | 6.0000% | 3.6112% | 35.69 bp | 3.9681% | 203.19 bp |
| 60M 6% level-pay, CPR 16.4% | 6.0000% | 3.5977% | 40.52 bp | 4.0029% | 199.71 bp |
| 24M float +2.25% | 5.8605% | 3.6112% | 35.69 bp | 3.9681% | 189.23 bp |
| 360M Prime -0.75%, CPR 10% | 6.3884% | 3.8816% | 73.95 bp | 4.6211% | 176.73 bp |

Prime/SOFR basis note: the lab's `PrimeLoan` defaults the basis to 3.1862%,
fit workbook-internally (month-1 Prime 7.46% minus the floating sheet's
month-1 SOFR reset 4.2738%, both on the September strip). The workbook's own
monthly Prime-minus-SOFR spread wobbles between roughly 3.11% and 3.34%
because Prime steps with 25 bp Fed moves while the SOFR strip is continuous;
the basis is exposed as an editable parameter for exactly that reason.
