/**
 * public/data の作図データを検証する。
 *
 * 経路探索を実装する前に、グラフがひと続きになっているか・
 * すべての建物に到着判定があるかを確認する。
 *
 * 使い方（リポジトリ直下で実行）:
 *   node scripts/check-data.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");

const { checkGraph } = await import(pathToFileURL(join(ROOT, "lib", "geo.ts")).href);

function load(name) {
  const p = join(DATA, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const campus = load("campus.geojson");
const buildings = load("buildings.geojson");
const cps = load("checkpoints.geojson");
const links = load("links.geojson");
const rooms = load("rooms.json");

const ng = [];
const line = (ok, text) => console.log(`${ok ? "✅" : "❌"} ${text}`);

console.log("=== 作図データの検証 ===\n");

line(!!campus && campus.features.length > 0, `敷地: ${campus?.features.length ?? 0} 件`);
line(
  !!buildings && buildings.features.length > 0,
  `場所: ${buildings?.features.length ?? 0} 件`,
);

const unnamed = (buildings?.features ?? []).filter(
  (f) => !f.properties.name && !f.properties.code,
);
line(unnamed.length === 0, `名称の入力: 残り ${unnamed.length} 件`);
if (unnamed.length) ng.push(`名称未入力 ${unnamed.length} 件`);

line(!!cps && cps.features.length > 0, `チェックポイント: ${cps?.features.length ?? 0} 件`);
line(!!links && links.features.length > 0, `接続: ${links?.features.length ?? 0} 本`);

/* --- 経路グラフの連結性 --- */

const linkProps = (links?.features ?? []).map((f) => f.properties);
const g = checkGraph(cps?.features ?? [], linkProps);

line(g.groups === 1, `経路のまとまり: ${g.groups} つ`);
if (g.groups !== 1) {
  ng.push(`経路が ${g.groups} つに分断`);
  console.log(`   切り離されているCP: ${[...g.isolated, ...g.unreachable].slice(0, 20).join(" / ")}`);
}

line(g.isolated.length === 0, `どこにもつながっていないCP: ${g.isolated.length} 件`);

/* --- 到着判定 --- */

const linked = new Set(
  (cps?.features ?? []).map((f) => f.properties.linkedTo).filter(Boolean),
);
const noEntrance = (buildings?.features ?? []).filter(
  (f) => !linked.has(f.properties.tempId),
);
line(noEntrance.length === 0, `到着判定がない場所: ${noEntrance.length} 件`);
if (noEntrance.length) {
  ng.push(`到着判定なし ${noEntrance.length} 件`);
  console.log(
    `   ${noEntrance
      .slice(0, 15)
      .map((f) => f.properties.name || f.properties.tempId)
      .join(" / ")}`,
  );
}

/* --- 部屋 --- */

if (rooms?.length) {
  const byBuilding = new Map();
  for (const r of rooms) byBuilding.set(r.buildingId, (byBuilding.get(r.buildingId) ?? 0) + 1);
  const noFloor = rooms.filter((r) => !r.floor);
  line(true, `部屋: ${rooms.length} 件 / ${byBuilding.size} 棟`);
  line(noFloor.length === 0, `階が未確認の部屋: ${noFloor.length} 件`);
} else {
  console.log(`⬜ 部屋: 未登録（無くても経路案内は動く）`);
}

/* --- まとめ --- */

console.log("");
if (ng.length === 0) {
  console.log("🎉 経路探索を実装できる状態です。");
} else {
  console.log(`残っている問題: ${ng.join(" / ")}`);
}
