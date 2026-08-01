/**
 * 国土地理院「基盤地図情報」の建築物データ（GML / JPGIS）を読み込む。
 *
 * ダウンロードした ZIP を展開すると得られる XML を、ブラウザ内で GeoJSON に変換する。
 * サーバもコマンドラインツールも不要。
 *
 * ★最大の注意点：GML の posList は「緯度 経度」の順で並んでいる。
 *   GeoJSON は [経度, 緯度] なので、必ず入れ替える。ここを間違えると
 *   日本のデータが地球の裏側（南米沖）に飛ぶ。
 *
 * ★DOMParser は使わない。
 *   2次メッシュ1枚の BldA は 90MB を超えることがあり、DOM 化すると
 *   メモリが 1GB 級に膨らんでタブが落ちる。テキストを直接走査する。
 *
 * 名前空間の接頭辞（gml: など）は配布時期によって差があるため、
 * タグ名は接頭辞を無視して照合する。
 */

import type { Position } from "geojson";

export type FgdBuilding = {
  /** 建物の外周リング（閉じている・[経度, 緯度]） */
  ring: Position[];
  /** 種別。例: "普通建物" "堅ろう建物" */
  type: string;
  /** 基盤地図情報の地物ID */
  fid: string;
};

/** [西, 南, 東, 北] */
export type Bbox = [number, number, number, number];

export type FgdParseResult = {
  /** bbox で絞り込んだ後の建物 */
  buildings: FgdBuilding[];
  /** ファイル内にあった BldA の総数（絞り込み前） */
  scanned: number;
  /** 最初に読めた座標。bbox で捨てたものも含む（座標順の検算用） */
  firstCoord: Position | null;
};

/** 接頭辞（gml: など）を無視して <tag>…</tag> の中身を取る */
function innerText(block: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`);
  return re.exec(block)?.[1]?.trim() ?? null;
}

/**
 * posList の中身を [経度, 緯度] の配列に変換する。
 * 空白・改行区切りで「緯度 経度 緯度 経度 …」と並んでいる。
 */
function parsePosList(text: string): Position[] {
  const nums = text
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  const ring: Position[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const lat = nums[i];
    const lon = nums[i + 1];
    ring.push([lon, lat]); // ★ここで入れ替える
  }
  return ring;
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) return ring;
  const [f] = ring;
  const l = ring[ring.length - 1];
  if (f[0] === l[0] && f[1] === l[1]) return ring;
  return [...ring, f];
}

/** リングの外接矩形が bbox と重なるか */
function overlaps(ring: Position[], b: Bbox): boolean {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return !(maxLon < b[0] || minLon > b[2] || maxLat < b[1] || minLat > b[3]);
}

/**
 * 基盤地図情報のXMLから建築物（BldA = 建築物の面）を抜き出す。
 * BldL（外周線）は面ではないため対象外。
 *
 * @param bbox 指定すると、外接矩形が重ならない建物を読み捨てる。
 *             メッシュ1枚には数十万棟あるため、これが無いとメモリが持たない。
 */
export function parseFgdBuildings(xmlText: string, bbox?: Bbox): FgdParseResult {
  const buildings: FgdBuilding[] = [];
  let scanned = 0;
  let firstCoord: Position | null = null;

  // <BldA …> … </BldA> を indexOf で切り出す。
  // 正規表現を 90MB 全体に当てるより速く、部分文字列も短命で GC されやすい。
  const OPEN = "<BldA";
  const CLOSE = "</BldA>";
  let cursor = 0;

  for (;;) {
    const start = xmlText.indexOf(OPEN, cursor);
    if (start < 0) break;
    const end = xmlText.indexOf(CLOSE, start);
    if (end < 0) break;
    const block = xmlText.slice(start, end);
    cursor = end + CLOSE.length;

    const posList = innerText(block, "posList");
    if (!posList) continue;

    const ring = closeRing(parsePosList(posList));
    if (ring.length < 4) continue; // 閉じたポリゴンには最低4点必要

    scanned += 1;
    firstCoord ??= ring[0];

    if (bbox && !overlaps(ring, bbox)) continue;

    buildings.push({
      ring,
      type: innerText(block, "type") ?? "建物",
      fid: innerText(block, "fid") ?? "",
    });
  }

  if (scanned === 0 && xmlText.includes("<BldL")) {
    throw new Error(
      "このファイルは BldL（建築物の「線」）です。ファイル名に BldA が入っている方を選んでください。",
    );
  }

  return { buildings, scanned, firstCoord };
}

/** 読み込んだデータの妥当性を大まかに確認する（座標順の取り違えを検出する） */
export function sanityCheck(r: FgdParseResult): string | null {
  if (r.scanned === 0 || !r.firstCoord) {
    return "建築物データ（BldA）が見つかりませんでした。ファイル名に BldA が入っているか確認してください。";
  }
  const [lon, lat] = r.firstCoord;
  // 日本の範囲からおおきく外れていたら、緯度経度が逆の可能性が高い
  if (lon < 122 || lon > 154 || lat < 20 || lat > 46) {
    return `座標が日本の範囲外です（経度${lon.toFixed(3)} 緯度${lat.toFixed(3)}）。緯度経度の順序が想定と異なる可能性があります。`;
  }
  return null;
}
