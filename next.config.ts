import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  headers: async () => [
    {
      // Prevent browsers from caching the tasks HTML file
      source: '/tasks.html',
      headers: [{ key: 'Cache-Control', value: 'no-store' }],
    },
  ],
  redirects: async () => [
    // Lead Performance + Lead Spend merged into /lead-roi (2026-07-13) —
    // old bookmarks keep working.
    { source: '/lead-performance', destination: '/lead-roi', permanent: true },
    { source: '/lead-spend', destination: '/lead-roi', permanent: true },
  ],
};

export default nextConfig;
