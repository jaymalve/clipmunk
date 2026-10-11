import type { NextConfig } from "next";

// The site is a standalone app inside the SDK repo; pin the root so Next does not pick the SDK's lockfile.
const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
