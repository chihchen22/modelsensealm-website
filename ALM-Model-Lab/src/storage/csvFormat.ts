/**
 * CSV formatters matching Steph's existing convention at
 * `ALM-Modeling-Book/chapters/ch03/sofr_paths_100x_v1.csv`:
 *   Header row: Month, Year, path_001, ..., path_N
 *   Data rows: 360 monthly observations, decimal annualised rates.
 */

const MAX_CSV_PATHS = 2000;
const MAX_CSV_STEPS = 5000;

export interface PathMatrix {
  /** Length nSteps. */
  times: ArrayLike<number>;
  /** Outer length nPaths, each inner length nSteps. */
  paths: ArrayLike<ArrayLike<number>>;
}

export function formatPathsCsv(matrix: PathMatrix): string {
  const { times, paths } = matrix;
  const nPaths = paths.length;
  const nSteps = times.length;

  const header = ["Month", "Year"];
  for (let p = 0; p < nPaths; p++) header.push(`path_${String(p + 1).padStart(3, "0")}`);

  const lines: string[] = [header.join(",")];
  for (let k = 0; k < nSteps; k++) {
    const row = [String(k + 1), times[k].toFixed(4)];
    for (let p = 0; p < nPaths; p++) {
      row.push(paths[p][k].toFixed(6));
    }
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse a CSV produced by `formatPathsCsv` back into a PathMatrix.
 * Used by Load Run to reconstruct simulation results.
 */
export function parsePathsCsv(text: string): { times: Float64Array; paths: Float64Array[] } {
  const rows = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (rows.length < 2) {
    throw new Error("CSV has fewer than two rows");
  }
  const header = rows[0].split(",");
  const nPaths = header.length - 2; // Month + Year + path_001..
  if (nPaths <= 0) throw new Error("CSV header missing path columns");
  if (nPaths > MAX_CSV_PATHS) throw new Error(`CSV has ${nPaths} path columns; max is ${MAX_CSV_PATHS}`);
  const nSteps = rows.length - 1;
  if (nSteps > MAX_CSV_STEPS) throw new Error(`CSV has ${nSteps} data rows; max is ${MAX_CSV_STEPS}`);
  const times = new Float64Array(nSteps);
  const paths: Float64Array[] = new Array(nPaths);
  for (let p = 0; p < nPaths; p++) paths[p] = new Float64Array(nSteps);

  for (let k = 0; k < nSteps; k++) {
    const cells = rows[k + 1].split(",");
    const t = parseFloat(cells[1]);
    if (!Number.isFinite(t)) throw new Error(`Non-numeric year value at CSV row ${k + 2}`);
    times[k] = t;
    for (let p = 0; p < nPaths; p++) {
      const v = parseFloat(cells[2 + p]);
      if (!Number.isFinite(v)) throw new Error(`Non-numeric rate value at row ${k + 2}, path column ${p + 1}`);
      paths[p][k] = v;
    }
  }
  return { times, paths };
}
