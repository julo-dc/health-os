import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  experimental: { serverActions: { bodySizeLimit: "12mb" } },
};

export default nextConfig;
