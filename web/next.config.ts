import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Repo has a lockfile at the parent (migration tooling); pin the app root to web/.
  turbopack: { root: path.resolve(__dirname) },
  // Course-material uploads go through a server action; the bucket caps files at
  // 15MB, so allow headroom above that (default server-action body limit is 1MB).
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Clickjacking: the app has no embed use case — deny all framing.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
