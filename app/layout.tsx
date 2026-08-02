import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // タブに出る名前。案内画面が入口なのでこれだけにする
  title: "KIT map",
  description: "金沢工業大学 扇が丘キャンパスの案内マップ",
};

/**
 * 画面そのものは拡大させない。
 *
 * iOS Safari はボタンの二度押しをダブルタップとみなしてページを拡大する。
 * 地図には自前の拡大縮小があるので、ページ側の拡大は邪魔にしかならない。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
