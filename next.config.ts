import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep puppeteer + chromium-min external. chromium-min ships no binary — it
  // downloads the full Chromium pack (binary + libs) to /tmp at runtime — so we
  // no longer need to force-bundle anything.
  serverExternalPackages: ['@sparticuz/chromium-min', 'puppeteer-core'],
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
