import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
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
  },
  outputFileTracingExcludes: {
    "/api/sessions": ["../../apps/web/next.config.ts"],
    "/api/sessions/*": ["../../apps/web/next.config.ts"],
  },
  reactStrictMode: true,
};

export default nextConfig;
