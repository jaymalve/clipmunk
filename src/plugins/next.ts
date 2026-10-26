import { fileURLToPath } from "node:url";

/** `clipmunk/next`: `withClipmunk(nextConfig)` marks every host element with the source file
 * that rendered it (`data-clipmunk-src`) in `next dev` with webpack (`next dev --webpack` on
 * Next 16), through a loader that runs after Next's own compiler. Production builds and
 * Turbopack are left untouched, so a take recorded there simply has no source files.
 */
type WebpackConfig = { module: { rules: unknown[] } };
type WebpackContext = { dev: boolean; dir: string };
type NextConfig = {
  webpack?: (config: WebpackConfig, context: WebpackContext) => WebpackConfig;
  turbopack?: Record<string, unknown>;
  [key: string]: unknown;
};

const LOADER = fileURLToPath(new URL(/* @vite-ignore */ "./next-loader.cjs", import.meta.url));

export function withClipmunk<T extends NextConfig>(nextConfig: T = {} as T): T {
  return {
    ...nextConfig,
    // A turbopack key says the webpack hook is intended, so Next 16 does not refuse to build.
    turbopack: nextConfig.turbopack ?? {},
    webpack(config: WebpackConfig, context: WebpackContext) {
      const result = nextConfig.webpack ? nextConfig.webpack(config, context) : config;
      if (context.dev)
        result.module.rules.push({
          test: /\.[jt]sx$/,
          exclude: /node_modules/,
          enforce: "post",
          use: [{ loader: LOADER, options: { root: context.dir } }],
        });
      return result;
    },
  };
}
export default withClipmunk;
