import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Standalone output bundles the Node server for Docker / Cloud Run
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Prevent Next from using the wrong monorepo root (parent package-lock.json)
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ["pdf-parse", "pptxgenjs"],
  experimental: {
    serverActions: { bodySizeLimit: "20mb" },
  },
  webpack: (config, { isServer, dev }) => {
    if (dev) {
      config.cache = false;
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
        ignored: ["**/node_modules/**", "**/.git/**"],
      };
    }
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        stream: false,
        os: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default nextConfig;
