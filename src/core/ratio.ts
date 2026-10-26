/** Output shapes a take can be reframed to and a scene rendered in. */
export const RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type Ratio = (typeof RATIOS)[number];
