import type { NextConfig } from "next";

// CF_BUILD=1 is set by the cf:* scripts (OpenNext → Cloudflare Workers). Cache Components rely on
// Node's setTimeout semantics and hang every page render in workerd (verified 2026-11-10), so the
// Cloudflare build renders pages the plain dynamic way; Vercel keeps the optimisation.
const forCloudflare = process.env.CF_BUILD === "1";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: !forCloudflare,
  serverExternalPackages: ["@libsql/client"],
  partialPrefetching: !forCloudflare,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
