import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the headless-Chromium packages out of the bundle — they ship a binary
  // and must load from node_modules at runtime (required for Vercel serverless).
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
  // Force the chromium binary AND its bundled shared libs (libnss3.so, etc.)
  // into the /api/generate-pdf function. Next's tracer otherwise misses these
  // data files because they're read via dynamic fs paths, not `import`ed —
  // which causes "libnss3.so: cannot open shared object file" at runtime.
  outputFileTracingIncludes: {
    '/api/generate-pdf': ['./node_modules/@sparticuz/chromium/**'],
  },
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
