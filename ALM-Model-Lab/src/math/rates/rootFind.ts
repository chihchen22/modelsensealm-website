/**
 * Brent's method for univariate root finding.
 *
 * Direct port of the standard algorithm (Brent 1973, "Algorithms for
 * Minimization without Derivatives", Ch 4). Used by the SOFR OIS bootstrap
 * to solve the par-swap equation node-by-node. Matches scipy.optimize.brentq
 * behaviour to numerical precision when the bracket is well-formed.
 */

export interface BrentOptions {
  xtol?: number;
  rtol?: number;
  maxIter?: number;
}

export class BrentBracketError extends Error {}

export function brentq(
  f: (x: number) => number,
  a: number,
  b: number,
  opts: BrentOptions = {},
): number {
  const xtol = opts.xtol ?? 1e-12;
  const rtol = opts.rtol ?? 1e-12;
  const maxIter = opts.maxIter ?? 200;

  let fa = f(a);
  let fb = f(b);
  if (fa * fb > 0) {
    throw new BrentBracketError(
      `brentq: f(a)=${fa} and f(b)=${fb} must have opposite signs`,
    );
  }

  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }

  let c = a;
  let fc = fa;
  let mflag = true;
  let s = b;
  let d = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    if (Math.abs(fb) < xtol) return b;
    if (Math.abs(b - a) < xtol + rtol * Math.abs(b)) return b;

    if (fa !== fc && fb !== fc) {
      // Inverse quadratic interpolation.
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // Secant.
      s = b - fb * ((b - a) / (fb - fa));
    }

    const cond1 = !((s > (3 * a + b) / 4 && s < b) || (s < (3 * a + b) / 4 && s > b));
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < xtol;
    const cond5 = !mflag && Math.abs(c - d) < xtol;
    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }

    const fs = f(s);
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }

  return b;
}
