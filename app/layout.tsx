import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // タブに出る名前。案内画面が入口なのでこれだけにする
  title: "KIT map",
  description: "金沢工業大学 扇が丘キャンパスの案内マップ",
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
