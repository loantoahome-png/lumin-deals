import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the headless-Chromium packages out of the bundle — they ship a binary
  // and must load from node_modules at runtime (required for Vercel serverless).
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
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
};

export default nextConfig;
