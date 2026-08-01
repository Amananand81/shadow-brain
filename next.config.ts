import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "@": path.resolve(__dirname),
    },
  },
  allowedDevOrigins: ["192.168.1.*"],
};

export default nextConfig;
