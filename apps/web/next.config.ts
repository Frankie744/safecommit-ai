import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  reactStrictMode: true,
};

export default nextConfig;
