import MapEditor from "@/components/MapEditor";

/**
 * 作図ツール。地図データを作るための管理用画面。
 *
 * 一般の利用者が見るのは `/`（案内画面）。
 * こちらは公開しても害はないが、入口からは辿れないようにしてある。
 */
export const metadata = { title: "作図ツール — KIT MAP" };

export default function EditPage() {
  return (
    <main className="h-full w-full">
      <MapEditor />
    </main>
  );
}
