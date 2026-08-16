/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static: every page is prerendered at build time from data/league.json.
  // No server, no serverless functions, so it runs free on Vercel indefinitely.
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
