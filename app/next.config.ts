import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "js", "jsx"],

  /**
   * Build output directory.
   *
   * `next build` and `next dev` both write here, and a production build run against a
   * directory a dev server is using corrupts it — you get `ENOENT ... page.js` for a route
   * whose manifest was written but whose page was not. Setting NEXT_DIST_DIR sends a
   * verification build somewhere else (see `npm run build:verify`) so it cannot collide
   * with a running dev server.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
