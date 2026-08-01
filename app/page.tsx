import MapEditor from "@/components/MapEditor";

/**
 * 作図ツールの入口。
 *
 * 以前は MapEditor を動的 import（遅延読み込み）していたが、
 * 開発時に maplibre-gl のコンパイルが完了せず
 * 「地図を読み込んでいます…」から進まない状態になったため、通常の import に戻した。
 *
 * MapEditor は "use client" で、window に触るのは useEffect の中だけなので
 * サーバ側で評価されても問題ない（next build のプリレンダで確認する）。
 */
export default function Page() {
  return (
    <main className="h-full w-full">
      <MapEditor />
    </main>
  );
}
