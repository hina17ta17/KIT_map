import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 開発中にスマホ実機など LAN 上の端末から開けるようにする。
  // 指定しないと HMR がブロックされ、警告が出続ける。
  allowedDevOrigins: ["172.20.0.92", "192.168.56.1", "localhost"],
};

export default nextConfig;
