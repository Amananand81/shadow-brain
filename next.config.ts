import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "@": path.resolve(__dirname),
    },
  },
  allowedDevOrigins: ["192.168.1.*", "192.168.31.*"],
};

export default nextConfig;
