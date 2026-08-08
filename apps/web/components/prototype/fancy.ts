// PROTOTYPE — the "fanciness" axis: five levels of visual richness applied
// to the winning variant. Level 1 is the approved baseline; each level adds
// more color, depth, and motion. The levels are intentionally qualitative —
// pick the highest one that still feels like "the app we approved".

export type FancyLevel = 1 | 2 | 3 | 4 | 5

export const FANCY_LEVELS: FancyLevel[] = [1, 2, 3, 4, 5]

export const FANCY_NAMES: Record<FancyLevel, string> = {
  1: "Baseline",
  2: "Polished",
  3: "Premium",
  4: "Rich",
  5: "Showcase",
}
