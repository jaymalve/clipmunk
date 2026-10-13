/** Facts the page repeats in several places. */
export const SITE = {
  name: "Clipmunk",
  packageName: "clipmunk",
  headline: "TypeScript SDK for product videos",
  tagline: "Ship the feature. Clipmunk cuts the clip.",
  description:
    "Clipmunk is a drop-in SDK for React and Next.js apps, added with one command. Your coding agent directs cinematic shots of your real UI, or you record a take yourself. Out comes a polished MP4 with a smooth cursor, auto-zooms and music, made on your machine.",
  github: process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/jaymalve/clipmunk",
} as const;
