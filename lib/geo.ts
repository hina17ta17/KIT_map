/**
 * 通路の作図を助ける幾何計算。
 *
 * 交差点で端点がわずかにズレていると、そこを曲がれず大回りする経路になる。
 * 見た目では 1m のズレを判別できないため、吸着と検証を機械側で行う。
 */

import type { Position } from "geojson";
import type { CheckpointFeature, LinkProps, PathFeature } from "./features";

const M_PER_DEG_LAT = 111_320;

/** 2点間の距離（メートル）。構内程度の範囲なら平面近似で十分 */
export function metersBetween(a: Position, b: Position): number {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * M_PER_DEG_LAT * Math.cos(midLat);
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** 線の長さ（メートル） */
export function lineLength(coords: Position[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += metersBetween(coords[i - 1], coords[i]);
  return sum;
}

/**
 * 既存の通路の頂点のうち、指定点に十分近いものへ吸着させる。
 * 見つからなければ元の点をそのまま返す。
 */
export function snapToVertices(
  pt: Position,
  paths: PathFeature[],
  extra: Position[],
  maxMeters: number,
): { pos: Position; snapped: boolean } {
  let best: Position | null = null;
  let bestD = maxMeters;

  const check = (v: Position) => {
    const d = metersBetween(pt, v);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  };

  for (const p of paths) for (const v of p.geometry.coordinates) check(v);
  for (const v of extra) check(v);

  return best ? { pos: [best[0], best[1]], snapped: true } : { pos: pt, snapped: false };
}

/**
 * 中心と半径（m）から円のポリゴンを作る。
 * MapLibre の circle は半径がピクセル指定で、拡大縮小すると実距離が変わってしまう。
 * 到着判定の範囲は実距離で見せたいので、面として描く。
 */
export function circlePolygon(center: Position, radiusM: number, steps = 48): Position[] {
  const lat = center[1] * (Math.PI / 180);
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = radiusM / (M_PER_DEG_LAT * Math.cos(lat));
  const ring: Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    ring.push([center[0] + dLon * Math.cos(t), center[1] + dLat * Math.sin(t)]);
  }
  return ring;
}

/**
 * 図形（建物の外周など）から、いちばん近い通路の頂点までの距離。
 * 通路が届いていない場所を洗い出すのに使う。通路が1本も無ければ Infinity。
 */
export function distanceToPaths(ring: Position[], paths: PathFeature[]): number {
  let best = Infinity;
  for (const p of paths) {
    for (const v of p.geometry.coordinates) {
      for (const r of ring) {
        const d = metersBetween(r, v);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/* ---------------- 経路グラフの検証 ---------------- */

/**
 * 通れる区間の隣接リスト。
 *
 * 辺は2種類ある。
 *  ① links     手動でつないだ区間（主に屋外）
 *  ② parents   親子関係。子に入るには親のどれか1つを通る必要がある
 */
function adjacency(cps: CheckpointFeature[], links: LinkProps[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const l of links) {
    if (!l.enabled) continue;
    add(l.from, l.to);
    add(l.to, l.from);
  }
  const ids = new Set(cps.map((c) => c.properties.id));
  for (const c of cps) {
    for (const p of c.properties.parents ?? []) {
      if (!ids.has(p)) continue; // 親が削除済み
      add(p, c.properties.id);
      add(c.properties.id, p);
    }
  }
  return adj;
}

export type GraphCheck = {
  /** どの接続にも属していないチェックポイント */
  isolated: string[];
  /** island の数。2以上なら経路がつながっていない塊がある */
  groups: number;
  /** 最大の塊に入っていないチェックポイント。ここへは案内できない */
  unreachable: string[];
};

/**
 * 経路グラフがひと続きになっているかを調べる。
 *
 * 分断されていると、その先のチェックポイントには到達できず
 * 「経路が見つかりません」になる。作図の段階で気づけるようにする。
 */
export function checkGraph(cps: CheckpointFeature[], links: LinkProps[]): GraphCheck {
  const ids = cps.map((c) => c.properties.id);
  const adj = adjacency(cps, links);
  const isolated = ids.filter((id) => !adj.has(id));

  const seen = new Set<string>();
  const groups: string[][] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    const group: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    groups.push(group);
  }

  // いちばん大きい塊を「本体」とみなし、そこに入っていないものを到達不可とする
  const main = groups.reduce<string[]>((a, b) => (b.length > a.length ? b : a), []);
  const mainSet = new Set(main);
  return {
    isolated,
    groups: groups.length,
    unreachable: ids.filter((id) => !mainSet.has(id)),
  };
}

/**
 * どの通路ともつながっていない端点を探す。
 *
 * 端点が他の通路の「頂点」と一致していれば接続とみなす。
 * 途中で交差しているだけ（頂点を共有していない）場合はつながっていない。
 */
export function findDangling(paths: PathFeature[], toleranceM = 1): Position[] {
  const out: Position[] = [];

  for (const p of paths) {
    const coords = p.geometry.coordinates;
    if (coords.length < 2) continue;

    for (const end of [coords[0], coords[coords.length - 1]]) {
      let connected = false;
      for (const q of paths) {
        if (q === p) continue;
        for (const v of q.geometry.coordinates) {
          if (metersBetween(end, v) <= toleranceM) {
            connected = true;
            break;
          }
        }
        if (connected) break;
      }
      if (!connected) out.push(end);
    }
  }
  return out;
}
