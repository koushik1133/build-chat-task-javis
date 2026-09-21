import type { NextConfig } from "next";
import path from "path";
import { buildSecurityHeaders, EMBEDDABLE_ROUTE_SOURCES } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Standalone output bundles the Node server for Docker / Cloud Run
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Prevent Next from using the wrong monorepo root (parent package-lock.json)
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ["pdf-parse", "pptxgenjs", "pg", "@aws/aurora-dsql-node-postgres-connector"],
  experimental: {
    serverActions: { bodySizeLimit: "20mb" },
  },
  async headers() {
    const env = {
      isDev: process.env.NODE_ENV !== "production",
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      cspEnforce: process.env.CSP_ENFORCE === "1",
      turnstile: Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    };
    return [
      // Public embeddable surfaces (portal, booking, widget script) may be framed anywhere.
      ...EMBEDDABLE_ROUTE_SOURCES.map((source) => ({
        source,
        headers: buildSecurityHeaders({ ...env, embeddable: true }),
      })),
      // Everything else: deny framing.
      {
        source: "/((?!p/|book/|api/leads/widget/).*)",
        headers: buildSecurityHeaders({ ...env, embeddable: false }),
      },
    ];
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
