import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root has its own lockfile (the Electron app). Point Turbopack at
  // this directory so it stops inferring the wrong workspace root.
  turbopack: { root: __dirname },
};

export default nextConfig;
