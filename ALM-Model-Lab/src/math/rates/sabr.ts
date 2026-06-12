/**
 * SABR closed forms with normal (Bachelier) volatility output.
 *
 * Port of `research/sabr.py`. Implements the Hagan-Kumar-Lesniewski-Woodward
 * 2002 closed form in the beta=0 (Bachelier) limit.
 *
 * Reference: Hagan et al., "Managing Smile Risk", Wilmott 2002, Eq A.69a.
 */

/**
 * SABR normal vol in the beta=0 limit (Bachelier).
 *
 * @param forward ATM forward rate (decimal).
 * @param strike Strike (decimal).
 * @param expiry Time to expiry (years).
 * @param alpha SABR alpha (vol-of-rate).
 * @param rho SABR rho (correlation).
 * @param nu SABR nu (vol-of-vol).
 * @returns Implied normal volatility (decimal). Multiply by 1e4 for bps.
 */
export function sabrNormalVol(
  forward: number,
  strike: number,
  expiry: number,
  alpha: number,
  rho: number,
  nu: number,
): number {
  const eps = 1e-7;
  const higherOrder = 1.0 + ((2.0 - 3.0 * rho * rho) * nu * nu / 24.0) * expiry;

  if (Math.abs(forward - strike) < eps) {
    return alpha * higherOrder;
  }

  const z = (nu / alpha) * (forward - strike);
  let arg = (Math.sqrt(1.0 - 2.0 * rho * z + z * z) + z - rho) / (1.0 - rho);
  if (arg <= 0.0) {
    arg = eps;
  }
  const x = Math.log(arg);
  return alpha * (z / x) * higherOrder;
}
