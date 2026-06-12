import { describe, expect, it } from "vitest";
import { formatPathsCsv, parsePathsCsv } from "../csvFormat";

describe("CSV path formatter", () => {
  it("round-trips a small matrix to within 1e-5", () => {
    const times = [1 / 12, 2 / 12, 3 / 12];
    const paths = [
      [0.036486, 0.037102, 0.038011],
      [0.035711, 0.036212, 0.037003],
    ];
    const csv = formatPathsCsv({ times, paths });
    const parsed = parsePathsCsv(csv);
    expect(parsed.times.length).toBe(3);
    expect(parsed.paths.length).toBe(2);
    expect(parsed.times[0]).toBeCloseTo(times[0], 4);
    expect(parsed.paths[0][0]).toBeCloseTo(0.036486, 5);
    expect(parsed.paths[1][2]).toBeCloseTo(0.037003, 5);
  });

  it("matches Steph's existing convention header (Month, Year, path_001..)", () => {
    const csv = formatPathsCsv({
      times: [1 / 12],
      paths: [[0.04]],
    });
    const header = csv.split("\n")[0];
    expect(header).toBe("Month,Year,path_001");
  });
});
