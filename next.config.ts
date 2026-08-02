import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 開発中にスマホ実機など LAN 上の端末から開けるようにする。
  // 指定しないと HMR がブロックされ、警告が出続ける。
  allowedDevOrigins: ["172.20.0.92", "192.168.56.1", "localhost"],

  // 左下に出る開発用のインジケータ（N のボタン）を隠す。
  // 地図の操作の邪魔になるため。エラーは従来どおり表示される。
  devIndicators: false,
};

export default nextConfig;
