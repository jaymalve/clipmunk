/** Facts the page repeats in several places. */
export const SITE = {
  name: "Clipmunk",
  packageName: "clipmunk",
  tagline: "Ship the feature. Clipmunk cuts the clip.",
  description:
    "Clipmunk lives inside your web app. Your coding agent directs cinematic shots of your real UI, you record a take with one shortcut, and Clipmunk handles the cursor, zooms and soundtrack.",
  github: process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/jaymalve/clipmunk",
} as const;
