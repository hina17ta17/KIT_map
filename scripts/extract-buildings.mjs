/**
 * 基盤地図情報の BldA から、キャンパス周辺の建物だけを抜き出して GeoJSON にする。
 *
 * ブラウザの作図ツール（/）と同じ lib/fgd.ts を使うので結果は一致する。
 * 地図が表示できない環境でもデータ作成を止めないための代替経路。
 *
 * 使い方（リポジトリ直下で実行）:
 *   node --max-old-space-size=4096 scripts/extract-buildings.mjs
 *
 * 既定では raw/ 以下の *BldA*.xml をすべて読み、
 * public/data/ に buildings.geojson と campus.geojson を書き出す。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const RAW = join(WEB, "raw"); // リポジトリ直下の raw/（.gitignore 済み）
const OUT = join(WEB, "public", "data");

// .ts を直接読む（Node 22+ の型ストリップ）。パスに日本語が入るので URL 化する。
const { parseFgdBuildings, sanityCheck } = await import(
  pathToFileURL(join(WEB, "lib", "fgd.ts")).href
);
const { CAMPUS_ROUGH_BBOX } = await import(pathToFileURL(join(WEB, "lib", "gsi.ts")).href);

/** ディレクトリを再帰的に辿って条件に合うファイルを集める */
function walk(dir, test, found = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, test, found);
    else if (test(e.name)) found.push(p);
  }
  return found;
}

if (!existsSync(RAW)) {
  console.error(`raw フォルダがありません: ${RAW}`);
  console.error("基盤地図情報の ZIP を展開して raw/ に置いてください。");
  process.exit(1);
}

const files = walk(RAW, (n) => /BldA.*\.xml$/i.test(n));
if (files.length === 0) {
  console.error(`raw/ に BldA の XML が見つかりません。`);
  console.error("ファイル名に BldA を含むもの（BldL ではない）が必要です。");
  process.exit(1);
}

const bbox = CAMPUS_ROUGH_BBOX;
console.log(`対象範囲: 経度 ${bbox[0]}〜${bbox[2]} / 緯度 ${bbox[1]}〜${bbox[3]}`);
console.log(`対象ファイル: ${files.length} 件\n`);

// 同じメッシュを二重に置いてしまっても正しい結果になるよう、地物ID で重複を除く
const byFid = new Map();
let scanned = 0;
let firstCoord = null;
let dupes = 0;

for (const f of files) {
  const t0 = Date.now();
  const r = parseFgdBuildings(readFileSync(f, "utf8"), bbox);
  scanned += r.scanned;
  firstCoord ??= r.firstCoord;

  let added = 0;
  for (const b of r.buildings) {
    // fid が空のデータもあり得るので、その場合は座標を鍵にする
    const key = b.fid || JSON.stringify(b.ring[0]);
    if (byFid.has(key)) dupes += 1;
    else {
      byFid.set(key, b);
      added += 1;
    }
  }
  console.log(
    `  ${relative(RAW, f)}\n    ${r.scanned.toLocaleString()} 棟中 ${r.buildings.length} 棟が範囲内 → ${added} 棟を採用 (${Date.now() - t0}ms)`,
  );
}

const rings = [...byFid.values()];
if (dupes > 0) console.log(`\n重複 ${dupes} 棟を除外しました（同じメッシュが複数あります）`);

const problem = sanityCheck({ buildings: rings, scanned, firstCoord });
if (problem) {
  console.error(`\n${problem}`);
  process.exit(1);
}

if (rings.length === 0) {
  console.error("\n範囲内に建物が1棟もありません。メッシュ番号が違う可能性があります。");
  console.error("扇が丘キャンパスのメッシュは 543665 です。");
  process.exit(1);
}

const buildings = {
  type: "FeatureCollection",
  features: rings.map((b, i) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [b.ring] },
    properties: {
      tempId: `B-${String(i + 1).padStart(2, "0")}`,
      code: "",
      name: "",
      floors: 0,
      note: b.type,
    },
  })),
};

const [w, s, e, n] = bbox;
const campus = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
      properties: { name: "仮の敷地（矩形・要修正）" },
    },
  ],
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "buildings.geojson"), JSON.stringify(buildings, null, 2));
writeFileSync(join(OUT, "campus.geojson"), JSON.stringify(campus, null, 2));

console.log(`\n✅ ${rings.length} 棟を書き出しました`);
console.log(`   public/data/buildings.geojson`);
console.log(`   public/data/campus.geojson`);
console.log(`\n号館番号は作図ツールで [読み込み] してから入力してください。`);
