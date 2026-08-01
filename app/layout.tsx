import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KIT MAP — 作図ツール",
  description: "金沢工業大学キャンパスマップ：敷地・建物ポリゴンの作図ツール",
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
