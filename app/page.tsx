import Guide from "@/components/Guide";

/**
 * 案内画面。一般の利用者が見る入口。
 *
 * 地図データを作る作図ツールは /edit にある。
 * 公開したときに利用者が作図画面を見ないよう、入口を分けてある。
 */
export default function Page() {
  return (
    <main className="h-full w-full">
      <Guide />
    </main>
  );
}
