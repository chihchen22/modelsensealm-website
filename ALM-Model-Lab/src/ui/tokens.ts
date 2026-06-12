/**
 * Model Sense design tokens, mirrored from
 * `Model-Sense-Website/assets/design-system/design-system.html` and
 * `Model-Sense-Website/build/agent-dashboard.html`.
 *
 * Single source of truth for colors used in chart series, component
 * borders, and any non-CSS surface (e.g. Recharts color props).
 */

export const COLORS = {
  obsidian: "#121312",
  cloudDancer: "#F6F6F4",
  sand: "#D1CBC1",
  bookSteel: "#4A5568",
  bookNavy: "#1A202C",
  nodeTeal: "#2B7A78",
  nodeGreen: "#3D7A42",
  nodeOrange: "#C86A3A",
  nodePurple: "#7050A0",
} as const;

/**
 * Per-series chart colors (from Phase 3a requirements Section 11 decision 4).
 * - HW model => node-orange.
 * - BGM model => node-teal.
 * - SABR fitted => node-purple.
 * - Deterministic / market => obsidian.
 * - Percentile bands => sand at 30% alpha.
 */
export const SERIES = {
  hw: COLORS.nodeOrange,
  bgm: COLORS.nodeTeal,
  sabr: COLORS.nodePurple,
  deterministic: COLORS.obsidian,
  market: COLORS.obsidian,
  bandFill: "rgba(209, 203, 193, 0.30)", // sand at 30%
  hwBandFill: "rgba(200, 106, 58, 0.18)",
  bgmBandFill: "rgba(43, 122, 120, 0.18)",
} as const;

export const FONTS = {
  serif: '"Playfair Display", Georgia, serif',
  sans: '"Sora", system-ui, -apple-system, sans-serif',
} as const;

/** Internal vs public deployment mode. Driven by Vite env at build time. */
export type DeployMode = "internal" | "public";

export function getMode(): DeployMode {
  // VITE_PUBLIC_DEPLOY=true -> public; otherwise internal.
  return import.meta.env.VITE_PUBLIC_DEPLOY === "true" ? "public" : "internal";
}
