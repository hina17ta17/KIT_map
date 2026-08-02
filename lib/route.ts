/**
 * 経路探索。
 *
 * チェックポイントを節点、接続を辺とするグラフを A* で解く。
 * 節点98・辺153程度なので、外部ライブラリを使わず自前で持つ。
 * 依存が減るぶん、型の食い違いやビルドの失敗も起きない。
 */

import type { Position } from "geojson";
import type { AppData } from "./appdata";
import { metersBetween } from "./geo";
import type { CheckpointFeature } from "./features";

export type Graph = {
  pos: Map<string, Position>;
  /** 節点ID → [相手のID, コスト, 実距離(m)][] */
  adj: Map<string, { to: string; cost: number; meters: number }[]>;
  cp: Map<string, CheckpointFeature>;
};

export function buildGraph(data: AppData): Graph {
  const cps = data.checkpoints.features as CheckpointFeature[];
  const pos = new Map<string, Position>();
  const cp = new Map<string, CheckpointFeature>();
  for (const c of cps) {
    pos.set(c.properties.id, c.geometry.coordinates);
    cp.set(c.properties.id, c);
  }

  const adj = new Map<string, { to: string; cost: number; meters: number }[]>();
  const add = (a: string, b: string, cost: number, meters: number) => {
    const list = adj.get(a);
    if (list) list.push({ to: b, cost, meters });
    else adj.set(a, [{ to: b, cost, meters }]);
  };

  for (const l of data.links) {
    if (!l.enabled) continue; // 案内に使わない区間は入れない
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) continue;
    const m = metersBetween(a, b);
    // いちばん短い距離で行ける経路を出す。
    // 種別ごとの重みはデータに持っているが、探索では使わない
    // （使うと「少し遠回りでも大通り」になり、最短ではなくなる）。
    add(l.from, l.to, m, m);
    add(l.to, l.from, m, m);
  }

  // 親子関係も通れる辺として扱う（親を通れば子に入れる）
  for (const c of cps) {
    for (const p of c.properties.parents ?? []) {
      const a = pos.get(p);
      const b = pos.get(c.properties.id);
      if (!a || !b) continue;
      const m = metersBetween(a, b);
      add(p, c.properties.id, m, m);
      add(c.properties.id, p, m, m);
    }
  }

  return { pos, adj, cp };
}

/** 指定した位置にいちばん近い節点。maxMeters より遠ければ null */
export function nearestNode(
  graph: Graph,
  at: Position,
  maxMeters = 50,
): { id: string; meters: number } | null {
  let best: string | null = null;
  let bestD = maxMeters;
  for (const [id, p] of graph.pos) {
    const d = metersBetween(at, p);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best ? { id: best, meters: bestD } : null;
}

/** A* で最短経路を求める。見つからなければ null */
export function findPath(graph: Graph, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const goal = graph.pos.get(to);
  if (!goal || !graph.pos.has(from)) return null;

  const h = (id: string) => {
    const p = graph.pos.get(id);
    return p ? metersBetween(p, goal) : 0;
  };

  const g = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  // 節点数が少ないので、優先度付きキューは使わず毎回いちばん小さいものを探す
  const open = new Map<string, number>([[from, h(from)]]);

  while (open.size) {
    let cur = "";
    let curF = Infinity;
    for (const [id, f] of open) {
      if (f < curF) {
        curF = f;
        cur = id;
      }
    }
    if (cur === to) break;
    open.delete(cur);
    done.add(cur);

    for (const e of graph.adj.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      const ng = (g.get(cur) ?? Infinity) + e.cost;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        prev.set(e.to, cur);
        open.set(e.to, ng + h(e.to));
      }
    }
  }

  if (!g.has(to)) return null;
  const path: string[] = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    path.unshift(p);
    cur = p;
  }
  return path;
}

/**
 * 出入口が複数あるとき、いちばん短くなる組み合わせを選ぶ。
 *
 * ■ なぜ要るか
 *   建物には出入口がいくつもある。直線でいちばん近い出入口が、
 *   道なりでも近いとはかぎらない。壁や建物を回り込むと、
 *   遠く見えた出入口のほうが早く着くことがある。
 *   直線で決め打つと、そこで最短を取り逃す。
 *
 * ■ 進め方
 *   出発側の出入口すべてを距離0として同時に広げる（多点始点）。
 *   一度広げれば、すべての点への最短距離が分かるので、
 *   そこから目的側の出入口のうち最短のものを選ぶ。
 *   出入口の数が増えても探索は一度で済む。
 *
 *   ここでは推定値を使わない素直な広げ方（ダイクストラ）にしている。
 *   行き先が複数あると推定値の置き方が難しくなるうえ、
 *   648点では速さの差が出ないため。
 */
export function findBestPath(
  graph: Graph,
  fromIds: string[],
  toIds: string[],
): { path: string[]; meters: number } | null {
  const starts = fromIds.filter((id) => graph.pos.has(id));
  const goals = new Set(toIds.filter((id) => graph.pos.has(id)));
  if (starts.length === 0 || goals.size === 0) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const open = new Map<string, number>();
  for (const s of starts) {
    dist.set(s, 0);
    open.set(s, 0);
  }

  while (open.size) {
    // 節点が少ないので、優先度付きキューは使わず毎回いちばん小さいものを探す
    let cur = "";
    let curD = Infinity;
    for (const [id, d] of open) {
      if (d < curD) {
        curD = d;
        cur = id;
      }
    }
    open.delete(cur);
    done.add(cur);

    for (const e of graph.adj.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      const nd = curD + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, cur);
        open.set(e.to, nd);
      }
    }
  }

  // 目的側の出入口のうち、いちばん近いもの
  let best: string | null = null;
  let bestD = Infinity;
  for (const g of goals) {
    const d = dist.get(g);
    if (d != null && d < bestD) {
      bestD = d;
      best = g;
    }
  }
  if (!best) return null;

  const path = [best];
  let cur = best;
  for (;;) {
    const p = prev.get(cur);
    if (!p) break;
    path.unshift(p);
    cur = p;
  }
  return { path, meters: bestD };
}

/* ---------------- 案内文 ---------------- */

export type Step = {
  /** 「北へ」「右折して」など */
  turn: string;
  /** この手順で進む距離(m) */
  meters: number;
  /** 目印にする建物名。無ければ空 */
  landmark: string;
  text: string;
};

const COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];

/** 2点間の方位（度・北が0・時計回り） */
function bearing(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x =
    Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** 曲がり角の言い方。30度未満は曲がりとみなさない */
function turnWord(delta: number): string | null {
  const d = ((delta + 540) % 360) - 180; // -180〜180
  const a = Math.abs(d);
  if (a < 30) return null; // 直進に統合する
  if (a > 150) return "Uターンして";
  if (a > 120) return d > 0 ? "右後方へ" : "左後方へ";
  if (a > 60) return d > 0 ? "右折して" : "左折して";
  return d > 0 ? "右斜め前へ" : "左斜め前へ";
}

/**
 * 経路の節点列から手順の文章を作る。
 *
 * 素直に辿ると「5m直進、右に3度、8m直進…」と細切れになるので、
 * ・30度未満の曲がりは直進に統合
 * ・10m未満の区間は前後にくっつける
 * ・近くの建物名を目印にする
 */
export function buildSteps(
  graph: Graph,
  path: string[],
  data: AppData,
  destName: string,
): { steps: Step[]; meters: number; minutes: number } {
  const pts = path.map((id) => graph.pos.get(id)!).filter(Boolean);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += metersBetween(pts[i - 1], pts[i]);

  const round10 = (m: number) => Math.max(10, Math.round(m / 10) * 10);
  const format = (s: Step) =>
    `${s.landmark ? `${s.landmark}の角を ` : ""}${s.turn}${round10(s.meters)}m 進む`;

  const steps: Step[] = [];

  if (pts.length >= 2) {
    let segStart = 0;
    let prevB = bearing(pts[0], pts[1]);
    // 最初の区間だけは方角で言う（「北へ 60m」）
    let segTurn = `${COMPASS[Math.round(prevB / 45) % 8]}へ `;

    /** segStart〜endIdx をひとつの手順にまとめて積む */
    const emit = (endIdx: number, nextTurn: string) => {
      let m = 0;
      for (let i = segStart + 1; i <= endIdx; i++) m += metersBetween(pts[i - 1], pts[i]);
      if (m >= 1) {
        const last = steps[steps.length - 1];
        if (m < 10 && last) {
          // 10m未満の区間は独立させず、直前の手順に足す
          last.meters += m;
          last.text = format(last);
        } else {
          const s: Step = {
            turn: segTurn,
            meters: m,
            landmark: nearLandmark(pts[segStart], data),
            text: "",
          };
          s.text = format(s);
          steps.push(s);
        }
      }
      segStart = endIdx;
      segTurn = nextTurn;
    };

    for (let i = 1; i < pts.length - 1; i++) {
      const b = bearing(pts[i], pts[i + 1]);
      const word = turnWord(b - prevB);
      if (word) emit(i, word); // 30度以上曲がるところで区切る
      prevB = b;
    }
    emit(pts.length - 1, "");
  }

  steps.push({ turn: "", meters: 0, landmark: "", text: `${destName} に到着` });

  return {
    steps,
    meters: Math.round(total),
    // 分速80m（不動産表示の基準）。切り上げ
    minutes: Math.max(1, Math.ceil(total / 80)),
  };
}

/** 指定した点の近くにある建物名。50m以内でいちばん近いもの */
function nearLandmark(at: Position, data: AppData): string {
  let best = "";
  let bestD = 50;
  for (const b of data.buildings.features) {
    const ring = b.geometry.coordinates[0];
    for (const v of ring) {
      const d = metersBetween(at, v);
      if (d < bestD) {
        bestD = d;
        best = b.properties.name || (b.properties.code ? `${b.properties.code}号館` : "");
      }
    }
  }
  return best;
}
