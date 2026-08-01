/**
 * 経路探索の実装前に、データの「実装で困る点」を洗い出す。
 * check-data.mjs が形式の検証なのに対し、こちらは中身の妥当性を見る。
 *
 *   node scripts/audit-data.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const { metersBetween } = await import(pathToFileURL(join(ROOT, "lib", "geo.ts")).href);

const load = (n) => (existsSync(join(DATA, n)) ? JSON.parse(readFileSync(join(DATA, n), "utf8")) : null);
const campus = load("campus.geojson");
const buildings = load("buildings.geojson");
const cps = load("checkpoints.geojson");
const links = load("links.geojson");

const B = buildings.features;
const C = cps.features;
const L = links.features.map((f) => f.properties);
const cpById = new Map(C.map((f) => [f.properties.id, f]));

const warn = [];
const say = (ok, t) => console.log(`${ok ? "✅" : "⚠️ "} ${t}`);

/* ---------- 1. 参照の整合性 ---------- */
console.log("── 参照の整合性 ──");

const buildingIds = new Set(B.map((f) => f.properties.tempId));
const badLinked = C.filter((f) => f.properties.linkedTo && !buildingIds.has(f.properties.linkedTo));
say(badLinked.length === 0, `存在しない場所を指すCP: ${badLinked.length} 件`);
if (badLinked.length) warn.push("linkedTo の参照切れ");

const badLink = L.filter((l) => !cpById.has(l.from) || !cpById.has(l.to));
say(badLink.length === 0, `存在しないCPを指す接続: ${badLink.length} 本`);
if (badLink.length) warn.push("接続の参照切れ");

const badParent = C.filter((f) => (f.properties.parents ?? []).some((p) => !cpById.has(p)));
say(badParent.length === 0, `存在しない親を指すCP: ${badParent.length} 件`);

/* ---------- 2. 到着地点の妥当性 ---------- */
console.log("\n── 到着地点 ──");

function ringCenter(ring) {
  const pts = ring.slice(0, -1);
  const s = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
}
function minDistToRing(pt, ring) {
  let best = Infinity;
  for (const v of ring) best = Math.min(best, metersBetween(pt, v));
  return best;
}

const far = [];
for (const b of B) {
  const ring = b.geometry.coordinates[0];
  const ents = C.filter((c) => c.properties.linkedTo === b.properties.tempId);
  for (const e of ents) {
    const d = minDistToRing(e.geometry.coordinates, ring);
    if (d > 60) far.push({ b: b.properties.name || b.properties.tempId, e: e.properties.id, d });
  }
}
say(far.length === 0, `建物から60m以上離れた到着CP: ${far.length} 件`);
for (const f of far.slice(0, 8)) console.log(`     ${f.b} ← ${f.e}（${Math.round(f.d)}m）`);
if (far.length) warn.push("到着CPが建物から遠い");

const entCount = new Map();
for (const c of C) if (c.properties.linkedTo) entCount.set(c.properties.linkedTo, (entCount.get(c.properties.linkedTo) ?? 0) + 1);
const multi = [...entCount.values()].filter((n) => n > 1).length;
console.log(`     入口が複数ある場所: ${multi} 件（最も近い入口が選ばれる）`);

/* ---------- 3. 接続の妥当性 ---------- */
console.log("\n── 接続 ──");

const lens = L.map((l) => {
  const a = cpById.get(l.from)?.geometry.coordinates;
  const b = cpById.get(l.to)?.geometry.coordinates;
  return a && b ? metersBetween(a, b) : 0;
});
const zero = lens.filter((d) => d < 1).length;
const long = lens.filter((d) => d > 200).length;
say(zero === 0, `長さ1m未満の接続: ${zero} 本`);
say(long === 0, `200mを超える接続: ${long} 本（建物を突き抜けている可能性）`);
if (long) {
  L.forEach((l, i) => { if (lens[i] > 200) console.log(`     ${l.from}→${l.to} ${Math.round(lens[i])}m`); });
  warn.push("長すぎる接続");
}
console.log(`     長さ: 最短 ${Math.round(Math.min(...lens))}m / 平均 ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}m / 最長 ${Math.round(Math.max(...lens))}m`);

const kinds = {};
for (const l of L) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
console.log(`     種別: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
if (Object.keys(kinds).length === 1) console.log("     ※ 全て同じ種別。重み付けは効かないが経路は出る");
console.log(`     屋根あり: ${L.filter((l) => l.roofed).length} 本 ／ 案内から除外: ${L.filter((l) => !l.enabled).length} 本`);

/* ---------- 4. 検索の一意性 ---------- */
console.log("\n── 検索 ──");

const names = B.map((f) => f.properties.name).filter(Boolean);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
say(dup.length === 0, `同じ名前の場所: ${[...new Set(dup)].join(" / ") || "なし"}`);
if (dup.length) warn.push("名前の重複（検索で区別できない）");

/* ---------- 5. 圏内判定 ---------- */
console.log("\n── 圏内判定 ──");

function inPoly(pt, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const poly = campus.features[0].geometry.coordinates[0];
const outB = B.filter((f) => !inPoly(ringCenter(f.geometry.coordinates[0]), poly));
const outC = C.filter((f) => !inPoly(f.geometry.coordinates, poly));
say(outB.length === 0, `敷地の外にある場所: ${outB.length} 件`);
for (const f of outB.slice(0, 8)) console.log(`     ${f.properties.name || f.properties.tempId}`);
say(outC.length === 0, `敷地の外にあるCP: ${outC.length} 件`);
if (outB.length || outC.length) warn.push("敷地の外にデータがある（圏内判定で弾かれる）");
console.log(`     敷地の頂点数: ${poly.length - 1}`);

/* ---------- まとめ ---------- */
console.log("");
if (warn.length === 0) console.log("🎉 実装をふさぐ問題はありません。");
else console.log(`確認が必要: ${warn.join(" / ")}`);
