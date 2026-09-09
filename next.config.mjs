/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOT a static export any more. The Book needs to receive bets, and
  // `output: 'export'` prerenders route handlers into static files -- GET only,
  // no request body, no cookies -- so there is no endpoint a POST can reach.
  //
  // Nothing is lost by dropping it. Vercel's free tier includes serverless
  // functions, and every page that can still be prerendered at build time is:
  // the records, owners and h2h pages remain static HTML. Static export only
  // bought portability to dumb hosts like GitHub Pages, which we do not use.
  images: { unoptimized: true },
};

export default nextConfig;
