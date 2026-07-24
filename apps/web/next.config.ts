import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  outputFileTracingIncludes: {
    "/api/sessions": [
      "../../fixtures/battery-controller/**/*",
      "../../demo/candidate-patches/**/*",
    ],
    "/api/sessions/*": [
      "../../fixtures/battery-controller/**/*",
      "../../demo/candidate-patches/**/*",
    ],
    "/api/database-sessions": [
      "../../fixtures/logistics-mysql/**/*",
    ],
    "/api/database-sessions/*": [
      "../../fixtures/logistics-mysql/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "/api/sessions": ["../../apps/web/next.config.ts"],
    "/api/sessions/*": ["../../apps/web/next.config.ts"],
  },
  reactStrictMode: true,
};

export default nextConfig;
