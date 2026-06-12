# FTP Static-Strip Parity: Lab vs BBG Workbook (v2)

Date: 2026-06-10. Supersedes v1, which analyzed the pre-rebaseline workbook
(loan sheets cached on the 2025-09 strip while the BBG curve sheets were 3/31).
The owner has since recalculated and re-saved the workbook on the 2026-03-31
strip, so this revision is a true same-vintage 1:1 cross-check.

Harness: `research/ftp_parity_check.ts` (`npx tsx research/ftp_parity_check.ts`).
Inputs: `research/data/ftp_workbook_extract.json` (from `research/extract_ftp_workbook.py`,
reading `Static_Strip_FTP_example_BBG_YC.xlsm`) and `research/data/market_2026-03-31.json`.

## Headline

The workbook's FTP calculation is the same linear par-match as `ftp.ts`, and
with both sides now on the 2026-03-31 strip the two agree to sub-basis-point on
the fixed bullet. The vintage split documented in v1 is resolved: the floating
sheet's month-1 1M SOFR reset is now 3.6623% (was the 9/30 level 4.2738%), and
the fixed-24M IR FTP is 3.6119% (the 3/31 ~2Y par), not the September 3.3901%.
All remaining differences are conventions, quantified below; none indicate a
math defect on either side.

## True 1:1 cross-check (fixed-rate sheets)

| | workbook result cell | lab (own DFs, month/12) | lab-native (3/31 curve) |
|---|---|---|---|
| Fixed-24M IR FTP | 3.6119% | 3.6161% | 3.6112% |
| Fixed-24M all-in FTP | 3.9615% | - | 3.9681% |

The workbook (ACT/365) and the lab (month/12 on the workbook's own discount
factors) differ by 0.42 bp, the pure day-count quote basis. The lab-native
figure on its own bootstrapped 3/31 curve lands 0.07 bp from the workbook cell;
the near-coincidence is the DF difference between the workbook curve and the lab
bootstrap netting against the day-count basis, not an exact identity.

## Layer results

**A. Formula parity (workbook-internal).** Sheet par-match replicated from the
sheet's own columns: 24M bullet IR 3.6119% / all-in 3.9615%, both 0.00 bp from
the sheet's result cells. The 60M CPR-16.4% amortizer replicates to within
0.48 bp (IR) / 0.47 bp (all-in). This residual persists unchanged on the freshly
recalculated workbook, so the v1 attribution to cached-value skew is wrong: it
is a structural difference between the sheet's amortizer result cell and the
par-match replicated from its posted schedule columns. Sub-basis-point and
immaterial for teaching, but no longer a cache artifact.

**B. Day-count quote basis.** The sheet accrues FTP income on ACT/365 dated
fractions; the lab quotes on month/12. Same cashflows, same discount factors:
the quote-basis effect is +0.42 bp (bullet) / +0.29 bp (amortizer) on the FTP
rate. Immaterial for teaching purposes; documented so nobody chases it later.

**C. Cashflow mechanics.** Lab instruments driven by each sheet's own coupon
path reproduce the schedules:

- 24M fixed bullet and 24M floating bullet: principal and balance exact;
  interest exact after normalizing the sheet's day-count fraction to /12 (the
  sheets accrue interest as balance x coupon x dcf with dated fractions; raw gap
  up to 0.33 per 1,000 par in short months).
- 60M amortizer (CPR 16.4%) and 360M Prime (CPR 10%): level-pay re-amortized
  monthly on the remaining term, SMM = 1 - (1-CPR)^(1/12) on the post-scheduled
  balance, identical to `PrimeLoan`. Balance drift stays under 0.55% of par
  mid-schedule and converges; it is the compounding of the day-count interest
  difference through scheduled amortization, not a mechanics difference. Total
  principal returns par on both sides.

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
| 360M Prime -0.75%, CPR 10% | 6.2716% | 3.8811% | 73.89 bp | 4.6200% | 165.16 bp |

## Prime/SOFR basis (methodology, updated)

Prime is structurally the Fed Funds target upper bound + 300 bps: a discrete
rate that moves only when the Fed changes policy, while SOFR is continuous. The
owner's workbook used a simplifying flat assumption (Prime = 1M SOFR + ~312 bps),
which on the 3/31 strip implies a 6.80% Prime and a 6.05% month-1 loan coupon.

The lab instead defaults `PRIME_SOFR_BASIS_DEFAULT` to the structural spread held
constant: 2026-03-31 Prime 6.75% (= 3.75% target upper + 300 bps) minus SOFR
overnight 3.68% = **3.07%**. Added to the path 1M rate this gives a 5.9823% m1
Prime coupon, ~7 bp below the workbook's flat-spread figure. That gap is the
point, not an error: a Prime-indexed loan carries Prime/SOFR basis risk, and
swapping Prime back to SOFR is not free (historically ~10-25 bp on a 5Y swap,
and it varies), which is why Prime loans are often priced higher. The basis
stays an editable parameter because the spread re-fixes with each Fed step.

Historical (pre-rebaseline 2025-09 strip) references, for the audit trail:
fixed-24M IR 3.3901% / all-in 3.7416%; amort-60M IR 3.3881% / all-in 3.7920%;
prior Prime basis 3.1862% (September Prime 7.46% - 1M SOFR 4.2738%).
