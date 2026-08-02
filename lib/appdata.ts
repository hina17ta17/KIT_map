/**
 * 案内画面が読み込む地図データ。
 *
 * public/data/ に置いた静的ファイルを取得するだけ。
 * データベースもAPIキーも使わない。
 */

import type { FeatureCollection, LineString, Point, Polygon } from "geojson";
import type {
  BuildingProps,
  CampusProps,
  CheckpointProps,
  LinkProps,
  Room,
} from "./features";

export type AppData = {
  campus: FeatureCollection<Polygon, CampusProps>;
  buildings: FeatureCollection<Polygon, BuildingProps>;
  checkpoints: FeatureCollection<Point, CheckpointProps>;
  /** links.geojson は線として書き出してあるが、経路探索は properties だけ使う */
  links: LinkProps[];
  rooms: Room[];
};

const EMPTY: AppData = {
  campus: { type: "FeatureCollection", features: [] },
  buildings: { type: "FeatureCollection", features: [] },
  checkpoints: { type: "FeatureCollection", features: [] },
  links: [],
  rooms: [],
};

async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function loadAppData(): Promise<AppData> {
  const [campus, buildings, checkpoints, linkFc, rooms] = await Promise.all([
    getJson("/data/campus.geojson", EMPTY.campus),
    getJson("/data/buildings.geojson", EMPTY.buildings),
    getJson("/data/checkpoints.geojson", EMPTY.checkpoints),
    getJson<FeatureCollection<LineString, LinkProps>>("/data/links.geojson", {
      type: "FeatureCollection",
      features: [],
    }),
    getJson<Room[]>("/data/rooms.json", []),
  ]);

  return {
    campus,
    buildings,
    checkpoints,
    links: linkFc.features.map((f) => f.properties),
    rooms: Array.isArray(rooms) ? rooms : [],
  };
}

/* ---------------- 検索 ---------------- */

export type SearchHit = {
  /** 目的地の建物 */
  buildingId: string;
  /** 一覧に出す見出し。例: "23号館 302" */
  title: string;
  /** 補足。例: "3階" */
  sub: string;
  /** 並べ替え用。小さいほど良い */
  score: number;
};

/**
 * 表記ゆれを潰す。
 * `23・302` `23-302` `23 302` `23302` をすべて `23302` にする。
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9a-z぀-ヿ一-鿿]/g, "");
}

/**
 * 建物名・号館番号・部屋番号から目的地を探す。
 *
 * 完全一致 → 前方一致 → 部分一致 の順に並べる。
 * あいまい検索のライブラリを使わずに済むよう、表記ゆれは normalize で吸収する。
 */
export function search(data: AppData, query: string, limit = 8): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];

  const hits: SearchHit[] = [];
  const rank = (target: string) => {
    if (!target) return -1;
    if (target === q) return 0;
    if (target.startsWith(q)) return 1;
    if (target.includes(q)) return 2;
    return -1;
  };

  for (const b of data.buildings.features) {
    const p = b.properties;
    const cands = [p.name, p.code, p.code ? `${p.code}号館` : ""].filter(Boolean);
    let best = -1;
    for (const c of cands) {
      const r = rank(normalize(c));
      if (r >= 0 && (best < 0 || r < best)) best = r;
    }
    if (best >= 0) {
      hits.push({ buildingId: p.tempId, title: p.name || `${p.code}号館`, sub: "", score: best });
    }
  }

  const buildingName = new Map(
    data.buildings.features.map((b) => [
      b.properties.tempId,
      b.properties.name || `${b.properties.code}号館`,
    ]),
  );

  for (const r of data.rooms) {
    const bn = buildingName.get(r.buildingId);
    if (!bn) continue;
    // 「23302」「302」「情報演習室」「23号館302」のどれでも当たるようにする
    const cands = [r.code, r.name, `${bn}${r.code}`, `${bn}${r.name}`].filter(Boolean);
    let best = -1;
    for (const c of cands) {
      const rk = rank(normalize(c));
      if (rk >= 0 && (best < 0 || rk < best)) best = rk;
    }
    if (best >= 0) {
      hits.push({
        buildingId: r.buildingId,
        title: `${bn} ${r.code || r.name}`,
        sub: floorText(r.floor),
        // 部屋は建物より少し後ろに出す
        score: best + 0.5,
      });
    }
  }

  return hits.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, "ja")).slice(0, limit);
}

export function floorText(floor: number): string {
  if (!floor) return "";
  return floor < 0 ? `地下${-floor}階` : `${floor}階`;
}
