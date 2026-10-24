import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app runs entirely in the browser (IndexedDB + GitHub API), so it ships
  // as plain static files that can be hosted anywhere.
  output: "export",
  reactCompiler: true,
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
