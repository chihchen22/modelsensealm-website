/**
 * Lazy-loaded Plotly 3D vol-surface card.
 *
 * Renders one market surface (mesh with contour projection) plus optional
 * model-fit overlay markers. Plotly is dynamically imported on first mount so
 * the main bundle stays lean. Fully interactive: drag to rotate, scroll to
 * zoom, hover for quote-level detail.
 */

import { useEffect, useRef } from "react";

export interface SurfaceGrid {
  /** Column coordinates (x axis), e.g. strikes in % or tenors in years. */
  x: ReadonlyArray<number>;
  /** Row coordinates (y axis), e.g. expiries in years. */
  y: ReadonlyArray<number>;
  /** z[row][col] in bp; null where the snapshot has no quote. */
  z: ReadonlyArray<ReadonlyArray<number | null>>;
}

export interface OverlayPoints {
  name: string;
  x: ReadonlyArray<number>;
  y: ReadonlyArray<number>;
  z: ReadonlyArray<number>;
  color: string;
  /** "lines+markers" suits a 1D path (ATM column); grid-scattered fit points read better as plain markers. */
  mode?: "markers" | "lines+markers";
}

interface Props {
  /** Trace name shown on hover, e.g. "Cap surface". */
  surfaceName: string;
  grid: SurfaceGrid;
  overlays?: ReadonlyArray<OverlayPoints>;
  xTitle: string;
  yTitle: string;
  zTitle: string;
  height?: number;
}

/** Brand-purple ramp; light = low vol, deep = high vol. */
const COLORSCALE: Array<[number, string]> = [
  [0, "#ECE8F4"],
  [0.45, "#A18CC7"],
  [0.75, "#7050A0"],
  [1, "#352350"],
];

let plotlyPromise: Promise<typeof import("plotly.js-dist-min")> | null = null;
function getPlotly() {
  plotlyPromise ??= import("plotly.js-dist-min");
  return plotlyPromise;
}

export function VolSurface3D({
  surfaceName,
  grid,
  overlays = [],
  xTitle,
  yTitle,
  zTitle,
  height = 460,
}: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    void getPlotly().then((mod) => {
      const Plotly = (mod as { default?: unknown }).default ?? mod;
      const el = divRef.current;
      if (cancelled || !el) return;

      const traces: Array<Record<string, unknown>> = [
        {
          type: "surface",
          name: surfaceName,
          x: grid.x,
          y: grid.y,
          z: grid.z,
          colorscale: COLORSCALE,
          opacity: 0.96,
          showscale: true,
          colorbar: { title: { text: zTitle, side: "right" }, thickness: 14, len: 0.6 },
          contours: {
            z: { show: true, usecolormap: true, highlightcolor: "#C86A3A", project: { z: true } },
          },
          hovertemplate:
            `${xTitle}: %{x}<br>${yTitle}: %{y}<br>${zTitle}: %{z:.1f}<extra>${surfaceName}</extra>`,
        },
        ...overlays.map((o) => ({
          type: "scatter3d",
          mode: o.mode ?? "markers",
          name: o.name,
          x: o.x,
          y: o.y,
          z: o.z,
          line: { color: o.color, width: 4 },
          marker: { color: o.color, size: 4.5, symbol: "circle" },
          hovertemplate:
            `${xTitle}: %{x:.2f}<br>${yTitle}: %{y}<br>${zTitle}: %{z:.1f}<extra>${o.name}</extra>`,
        })),
      ];

      const layout = {
        autosize: true,
        height,
        margin: { l: 0, r: 0, t: 8, b: 0 },
        paper_bgcolor: "rgba(0,0,0,0)",
        font: { family: "var(--font-sans), Sora, sans-serif", size: 11, color: "#121312" },
        showlegend: overlays.length > 0,
        legend: { orientation: "h", x: 0, y: 1.04, font: { size: 11 } },
        scene: {
          xaxis: { title: { text: xTitle }, gridcolor: "rgba(18,19,18,0.12)", zerolinecolor: "rgba(18,19,18,0.2)" },
          yaxis: { title: { text: yTitle }, gridcolor: "rgba(18,19,18,0.12)", zerolinecolor: "rgba(18,19,18,0.2)" },
          zaxis: { title: { text: zTitle }, gridcolor: "rgba(18,19,18,0.12)", zerolinecolor: "rgba(18,19,18,0.2)" },
          camera: { eye: { x: 1.7, y: -1.7, z: 0.65 } },
          aspectmode: "manual",
          aspectratio: { x: 1.1, y: 1.1, z: 0.7 },
        },
      };

      const config = { responsive: true, displayModeBar: false };

      void (Plotly as {
        react: (el: HTMLElement, data: unknown, layout: unknown, config: unknown) => Promise<unknown>;
      }).react(el, traces, layout, config);

      resizeObserver = new ResizeObserver(() => {
        void (Plotly as { Plots: { resize: (el: HTMLElement) => void } }).Plots.resize(el);
      });
      resizeObserver.observe(el);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      const el = divRef.current;
      if (el) {
        void getPlotly().then((mod) => {
          const Plotly = (mod as { default?: unknown }).default ?? mod;
          (Plotly as { purge: (el: HTMLElement) => void }).purge(el);
        });
      }
    };
  }, [surfaceName, grid, overlays, xTitle, yTitle, zTitle, height]);

  return <div ref={divRef} style={{ width: "100%", height }} />;
}
