/**
 * 地図データの型定義とローカル保存。
 *
 * 建物は「仮ID」で先に描き、後から現地の看板を確認して号館番号を入れる運用にする。
 * これにより大学からの情報を待たずに作図を進められる。
 */

import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";

/**
 * 場所の種別。
 * 号館だけでなく、屋外設備（グラウンド・駐輪場）も目的地になりうるため分類する。
 */
export type Category = "hall" | "facility" | "outdoor" | "other";

export const CATEGORIES: {
  id: Category;
  label: string;
  /** 入力欄の例示 */
  example: string;
  /** 号館番号の欄を出すか */
  hasCode: boolean;
  /** 階数の欄を出すか */
  hasFloors: boolean;
  /** 塗りの色。航空写真の上に重ねるので淡くする */
  color: string;
  /** 枠線の色。塗りが淡いぶん、輪郭はここではっきりさせる */
  lineColor: string;
  /** ラベルを color で塗ったときの文字色。淡い色の上では濃い字にする */
  textColor: string;
}[] = [
  {
    id: "hall",
    label: "号館",
    example: "23",
    hasCode: true,
    hasFloors: true,
    color: "#ffffff",
    lineColor: "#475569",
    textColor: "#0f172a",
  },
  {
    id: "facility",
    label: "施設",
    example: "図書館 / 体育館 / 食堂",
    hasCode: false,
    hasFloors: true,
    color: "#a7f3d0",
    lineColor: "#059669",
    textColor: "#064e3b",
  },
  {
    id: "outdoor",
    label: "屋外",
    example: "グラウンド / 自転車小屋 / 駐車場",
    hasCode: false,
    hasFloors: false,
    color: "#bae6fd",
    lineColor: "#0284c7",
    textColor: "#0c4a6e",
  },
  {
    id: "other",
    label: "その他",
    example: "門 / 掲示板 / 未分類",
    hasCode: false,
    hasFloors: false,
    color: "#94a3b8",
    lineColor: "#475569",
    textColor: "#0f172a",
  },
];

export function categoryOf(c: Category) {
  return CATEGORIES.find((x) => x.id === c) ?? CATEGORIES[3];
}

export type BuildingProps = {
  /** 仮ID。作図順に自動採番される（B-01, B-02, ...）。名前が判明しても変更しない */
  tempId: string;
  /** 種別。号館・施設・屋外・その他 */
  category: Category;
  /** 号館番号。号館のときだけ使う。現地の看板を確認してから入れる。例: "23" */
  code: string;
  /** 名称。例: "23号館" "図書館" "第2グラウンド" "自転車小屋（東）" */
  name: string;
  /** 階数。分かる範囲で。0 は未確認。屋外では使わない */
  floors: number;
  /** メモ（現地確認時の気づきなど） */
  note: string;
};

export type CampusProps = {
  name: string;
};

/**
 * 通路の種別。
 * weight は経路探索のコスト倍率。距離そのものは変えず、探索上の重みだけ変える。
 * 細道の重みを上げると「少し遠回りでも大通りを通る」自然な経路になる。
 */
export type PathKind = "main" | "normal" | "narrow" | "stairs";

export const PATH_KINDS: {
  id: PathKind;
  label: string;
  /** 経路探索のコスト倍率 */
  weight: number;
  color: string;
  /** 地図上の線の太さ */
  width: number;
  hint: string;
}[] = [
  {
    id: "main",
    label: "主要通路",
    weight: 1.0,
    color: "#f59e0b",
    width: 5,
    hint: "幅の広いメインの道。優先的に案内される",
  },
  {
    id: "normal",
    label: "一般通路",
    weight: 1.2,
    color: "#fbbf24",
    width: 3.5,
    hint: "ふつうの通路",
  },
  {
    id: "narrow",
    label: "細道",
    weight: 1.6,
    color: "#fcd34d",
    width: 2.5,
    hint: "裏道・細い通路。遠回りしてでも避けられる",
  },
  {
    id: "stairs",
    label: "階段",
    weight: 1.5,
    color: "#ef4444",
    width: 3,
    hint: "段差あり。バリアフリー経路では通行止め扱いにできる",
  },
];

export function pathKindOf(k: PathKind) {
  return PATH_KINDS.find((x) => x.id === k) ?? PATH_KINDS[1];
}

export type PathProps = {
  /** 通路ID。P-01, P-02, ... */
  id: string;
  kind: PathKind;
  /** 屋根があるか。「雨に濡れないルート」に使う */
  roofed: boolean;
  /**
   * 案内に使ってよいか。
   * 「地図には描くが案内には使わせたくない道」を除外するための切り替え。
   * false の通路は経路探索のグラフに入らない。
   */
  enabled: boolean;
  note: string;
};

export type PathFeature = Feature<LineString, PathProps>;

/* ---------------- チェックポイント ---------------- */

/**
 * 到着判定・経路の目印に使う点。
 *
 * 屋内測位が無いので「建物に着いたか」を面で判定するのは精度が足りない。
 * 出入口に半径付きの点を置き、そこに入ったら到着とみなす。
 */
export type CheckpointKind = "entrance" | "gate" | "waypoint";

export const CHECKPOINT_KINDS: {
  id: CheckpointKind;
  label: string;
  color: string;
  /** 到着判定の既定半径（m） */
  radius: number;
  hint: string;
}[] = [
  {
    id: "entrance",
    label: "出入口",
    color: "#22c55e",
    radius: 12,
    hint: "建物の入口。ここに入ると「その場所に到着」と判定する",
  },
  {
    id: "gate",
    label: "門",
    color: "#0ea5e9",
    radius: 15,
    hint: "キャンパスの出入口。外からの経路の起点になる",
  },
  {
    id: "waypoint",
    label: "通過点",
    color: "#a855f7",
    radius: 20,
    hint: "案内の目印。「〇〇を通過」と出したい曲がり角など",
  },
];

export function checkpointKindOf(k: CheckpointKind) {
  return CHECKPOINT_KINDS.find((x) => x.id === k) ?? CHECKPOINT_KINDS[2];
}

export type CheckpointProps = {
  /** チェックポイントID。C-01, C-02, ... */
  id: string;
  kind: CheckpointKind;
  /** 表示名。例: "23号館 南口" */
  name: string;
  /** 到着判定の対象となる場所の tempId。空なら判定に使わない */
  linkedTo: string;
  /** この距離（m）以内に入ったら到着とみなす */
  radius: number;
  note: string;

  /**
   * 階層の深さ。
   * 1 = 外から直接入れる（門・建物の入口・屋外の分岐点）
   * 2以上 = 親を通らないと入れない（建物の中など）
   */
  level: number;

  /**
   * 親のチェックポイントID。
   *
   * **このうち「どれか1つ」を通れば入れる（OR条件）。**
   * 例：23号館に南口と北口があるなら、中の場所の親は2つ。
   *     どちらの入口から入っても到達できる。
   *
   * level 1 では空。level 2以上で空だと、どこからも入れない状態になる。
   */
  parents: string[];
};

export type CheckpointFeature = Feature<Point, CheckpointProps>;

/** 指定したチェックポイントを親に持つもの（直下の子だけ） */
export function childrenOf(cps: CheckpointFeature[], id: string): CheckpointFeature[] {
  return cps.filter((c) => c.properties.parents.includes(id));
}

/**
 * 親を1つも持たない level 2以上のチェックポイント。
 * どこからも入れないので、経路が出せない。
 */
export function orphanCheckpoints(cps: CheckpointFeature[]): CheckpointFeature[] {
  return cps.filter((c) => c.properties.level >= 2 && c.properties.parents.length === 0);
}

/* ---------------- 部屋（建物の中身） ---------------- */

/**
 * 建物の中の部屋。
 *
 * 経路案内は建物の入口までなので、部屋に座標は要らない。
 * 「どの建物の何階にあるか」だけ分かれば
 * 「302 は 3階です」と案内の最後に出せる。
 */
export type RoomCategory = "class" | "lab" | "office" | "facility" | "other";

export const ROOM_CATEGORIES: { id: RoomCategory; label: string; color: string }[] = [
  { id: "class", label: "教室", color: "#3b82f6" },
  { id: "lab", label: "研究室", color: "#8b5cf6" },
  { id: "office", label: "事務", color: "#f59e0b" },
  { id: "facility", label: "設備", color: "#10b981" },
  { id: "other", label: "その他", color: "#64748b" },
];

export function roomCategoryOf(c: RoomCategory) {
  return ROOM_CATEGORIES.find((x) => x.id === c) ?? ROOM_CATEGORIES[4];
}

export type Room = {
  /** 部屋ID。R-001, R-002, ... */
  id: string;
  /** どの建物か。BuildingProps.tempId */
  buildingId: string;
  /** 部屋番号。例: "302"。番号が無い部屋は空でよい */
  code: string;
  /** 名称。例: "情報演習室"。番号だけなら空でよい */
  name: string;
  /** 階。地下は負の数（B1 = -1）。0 は未確認 */
  floor: number;
  category: RoomCategory;
  /** 補足。「南口から入って正面の階段」など案内の最後に出す */
  hint: string;
};

/** 表示用のラベル */
export function roomLabel(r: Room): string {
  if (r.code && r.name) return `${r.code} ${r.name}`;
  return r.code || r.name || r.id;
}

/** 階の表示。地下は B1 のように出す */
export function floorLabel(floor: number): string {
  if (floor === 0) return "階不明";
  return floor < 0 ? `B${-floor}階` : `${floor}階`;
}

/**
 * 部屋番号から階を推測する。
 * 302 → 3階 / 1203 → 12階 / B01 → 地下1階。
 * 例外のある大学もあるので、あくまで初期値。入力側で直せるようにする。
 */
export function guessFloor(code: string): number {
  const t = code.trim().toUpperCase();
  const b = /^B(\d+)/.exec(t);
  if (b) return -Number(b[1]);
  const digits = t.replace(/\D/g, "");
  if (digits.length <= 2) return 0; // 判断できない
  if (digits.length === 3) return Number(digits[0]);
  return Number(digits.slice(0, digits.length - 2));
}

/* ---------------- 接続（経路グラフの辺） ---------------- */

/**
 * チェックポイントどうしの接続。
 *
 * 経路探索はこの接続の上だけを通る。接続していない区間は通れない。
 * 線の形はチェックポイントの座標から毎回作るので、点を動かしても線がずれない。
 */
export type LinkProps = {
  /** 接続ID。L-01, L-02, ... */
  id: string;
  /** つなぐチェックポイントのID */
  from: string;
  to: string;
  kind: PathKind;
  /** 屋根があるか */
  roofed: boolean;
  /** 案内に使ってよいか。false なら経路探索のグラフに入らない */
  enabled: boolean;
  note: string;
};

export type BuildingFeature = Feature<Polygon, BuildingProps>;
export type CampusFeature = Feature<Polygon, CampusProps>;

export type MapData = {
  campus: FeatureCollection<Polygon, CampusProps>;
  buildings: FeatureCollection<Polygon, BuildingProps>;
  /**
   * 下書きの通路線。チェックポイントを置く位置の目安に使う参考線で、
   * 経路探索には使わない（探索は checkpoints と links だけを見る）。
   */
  paths: FeatureCollection<LineString, PathProps>;
  /** 到着判定・目印の点。経路グラフの節点でもある */
  checkpoints: FeatureCollection<Point, CheckpointProps>;
  /**
   * チェックポイントどうしの接続。経路グラフの辺。
   * 形は checkpoints の座標から作るため、ここには座標を持たない。
   */
  links: LinkProps[];
  /** 建物の中の部屋。座標を持たないので配列で持つ */
  rooms: Room[];
};

export const EMPTY_DATA: MapData = {
  campus: { type: "FeatureCollection", features: [] },
  buildings: { type: "FeatureCollection", features: [] },
  paths: { type: "FeatureCollection", features: [] },
  checkpoints: { type: "FeatureCollection", features: [] },
  links: [],
  rooms: [],
};

const STORAGE_KEY = "kitmap.draft.v1";

/** 基盤地図情報の建物種別。取り込み時に note へ入る */
const FGD_TYPES = ["普通建物", "堅ろう建物", "普通無壁舎", "堅ろう無壁舎", "高層建物"];

/** 種別が未設定のデータから、もっともらしい種別を推測する */
function guessCategory(p: Partial<BuildingProps>): Category {
  if (p.code) return "hall";
  if (p.name) return "facility";
  // 基盤地図情報から取り込んだものは建築物なので号館を既定にする
  if (p.note && FGD_TYPES.includes(p.note)) return "hall";
  return "other";
}

/**
 * 古い保存データを現在の形に合わせる。
 *
 * category を後から足したため、それ以前に作ったデータには入っていない。
 * 作図済みの内容を失わせないよう、既存の値から推測して補う。
 */
function migrate(data: MapData): MapData {
  return {
    ...data,
    // paths / checkpoints は後から追加した。古い保存データには入っていない
    paths: {
      type: "FeatureCollection",
      features: (data.paths?.features ?? []).map((f) => ({
        ...f,
        // enabled も後から追加。既存の通路は「案内に使う」を既定にする
        properties: { ...f.properties, enabled: f.properties.enabled ?? true },
      })),
    },
    checkpoints: {
      type: "FeatureCollection",
      features: (data.checkpoints?.features ?? []).map((f) => ({
        ...f,
        // level / parents は後から追加。既存のCPは「外から入れる」= level 1 とする
        properties: {
          ...f.properties,
          level: f.properties.level ?? 1,
          parents: f.properties.parents ?? [],
        },
      })),
    },
    links: data.links ?? [],
    rooms: data.rooms ?? [],
    buildings: {
      ...data.buildings,
      features: data.buildings.features.map((f) => {
        const p = f.properties as Partial<BuildingProps>;
        if (p.category) return f;
        return { ...f, properties: { ...(p as BuildingProps), category: guessCategory(p) } };
      }),
    },
  };
}

export function loadData(): MapData {
  if (typeof window === "undefined") return EMPTY_DATA;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_DATA;
    const parsed = JSON.parse(raw) as MapData;
    if (!parsed.campus || !parsed.buildings) return EMPTY_DATA;
    return migrate(parsed);
  } catch {
    return EMPTY_DATA;
  }
}

export function saveData(data: MapData) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** 既存の仮IDと重ならない次の番号を返す（削除後の再採番はしない） */
export function nextTempId(features: BuildingFeature[]): string {
  let max = 0;
  for (const f of features) {
    const m = /^B-(\d+)$/.exec(f.properties.tempId ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `B-${String(max + 1).padStart(2, "0")}`;
}

/** 既存の通路IDと重ならない次の番号を返す */
export function nextPathId(features: PathFeature[]): string {
  let max = 0;
  for (const f of features) {
    const m = /^P-(\d+)$/.exec(f.properties.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(2, "0")}`;
}

/** 既存のチェックポイントIDと重ならない次の番号を返す */
export function nextCheckpointId(features: CheckpointFeature[]): string {
  let max = 0;
  for (const f of features) {
    const m = /^C-(\d+)$/.exec(f.properties.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `C-${String(max + 1).padStart(2, "0")}`;
}

/** 既存の接続IDと重ならない次の番号を返す */
export function nextLinkId(links: LinkProps[]): string {
  let max = 0;
  for (const l of links) {
    const m = /^L-(\d+)$/.exec(l.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `L-${String(max + 1).padStart(2, "0")}`;
}

/** 既存の部屋IDと重ならない次の番号を返す */
export function nextRoomId(rooms: Room[]): string {
  let max = 0;
  for (const r of rooms) {
    const m = /^R-(\d+)$/.exec(r.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `R-${String(max + 1).padStart(3, "0")}`;
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 表示用のラベル。名前が未入力なら仮IDを出す */
export function buildingLabel(p: BuildingProps): string {
  if (p.name) return p.name;
  if (p.code) return `${p.code}号館`;
  return p.tempId;
}

/** 名前が入っているか（進捗の集計と一覧表示に使う） */
export function isNamed(p: BuildingProps): boolean {
  return Boolean(p.name || p.code);
}
