"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MlMap,
  Marker,
  NavigationControl,
  ScaleControl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, Polygon, Position } from "geojson";
// @turf/turf（全部入り）ではなく個別パッケージを使う。
// 全部入りは巨大で、開発時のコンパイルが数分単位で止まる原因になる。
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import {
  BASES,
  BASE_ORDER,
  CAMPUS_ROUGH_BBOX,
  GSI_ATTRIBUTION,
  INITIAL_VIEW,
  type BaseId,
} from "@/lib/gsi";
import { parseFgdBuildings, sanityCheck, type Bbox, type FgdBuilding } from "@/lib/fgd";
import {
  CATEGORIES,
  EMPTY_DATA,
  buildingLabel,
  categoryOf,
  downloadJson,
  isNamed,
  loadData,
  nextTempId,
  saveData,
  type BuildingFeature,
  nextPathId,
  nextCheckpointId,
  nextLinkId,
  pathKindOf,
  checkpointKindOf,
  nextRoomId,
  childrenOf,
  orphanCheckpoints,
  roomCategoryOf,
  floorLabel,
  guessFloor,
  PATH_KINDS,
  CHECKPOINT_KINDS,
  ROOM_CATEGORIES,
  type BuildingProps,
  type CheckpointFeature,
  type CheckpointProps,
  type LinkProps,
  type MapData,
  type Room,
  type PathFeature,
  type PathProps,
} from "@/lib/features";
import {
  checkGraph,
  circlePolygon,
  distanceToPaths,
  findDangling,
  lineLength,
  metersBetween,
  snapToVertices,
} from "@/lib/geo";

/** これより遠いと「通路が届いていない」とみなす距離 */
const REACH_METERS = 25;

type Mode = "none" | "campus" | "building" | "path" | "checkpoint" | "child" | "link";

/** 交差点で端点を確実に共有させるための吸着距離 */
const SNAP_METERS = 4;

/**
 * クリック位置にいちばん近いチェックポイントを返す。
 *
 * queryRenderedFeatures は「実際に描画されている」ことが前提で、
 * レイヤやスタイルの状態に左右されて当たらないことがある。
 * 座標を画面座標に変換して距離で選べば、描画の状態に依存せず必ず当たる。
 */
function nearestCp(
  map: MlMap,
  point: { x: number; y: number },
  cps: CheckpointFeature[],
  maxPx = 22,
): CheckpointFeature | null {
  let best: CheckpointFeature | null = null;
  let bestD = maxPx;
  for (const c of cps) {
    const [lon, lat] = c.geometry.coordinates;
    const p = map.project([lon, lat]);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

const MODE_LABEL: Record<Mode, string> = {
  none: "",
  campus: "敷地",
  building: "場所",
  path: "通路",
  checkpoint: "チェックポイント",
  child: "この先の場所",
  link: "接続",
};

/** リングの平均座標。ラベルの置き場所に使う（厳密な重心でなくてよい） */
function ringCenter(ring: Position[]): [number, number] {
  const pts = ring.slice(0, -1);
  const sum = pts.reduce<[number, number]>(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
    [0, 0],
  );
  return [sum[0] / pts.length, sum[1] / pts.length];
}

function toPolygon(coords: Position[]): Polygon {
  return { type: "Polygon", coordinates: [[...coords, coords[0]]] };
}

/**
 * 種別ごとの色分けを MapLibre の式にする。
 * 色の定義は CATEGORIES 一箇所だけなので、凡例と地図がずれない。
 */
/** 通路の種別ごとの色・太さを MapLibre の式にする */
function pathKindExpr(key: "color" | "width"): ExpressionSpecification {
  const last = PATH_KINDS[PATH_KINDS.length - 1];
  return [
    "match",
    ["get", "kind"],
    ...PATH_KINDS.slice(0, -1).flatMap((k) => [k.id, k[key]]),
    last[key],
  ] as unknown as ExpressionSpecification;
}

function categoryColorExpr(key: "color" | "lineColor"): ExpressionSpecification {
  const last = CATEGORIES[CATEGORIES.length - 1];
  return [
    "match",
    ["get", "category"],
    ...CATEGORIES.slice(0, -1).flatMap((c) => [c.id, c[key]]),
    last[key], // 既定（種別が未設定の古いデータもここに来る）
  ] as unknown as ExpressionSpecification;
}

/** 敷地フィーチャ群を囲む外接矩形 [西, 南, 東, 北] */
function campusBbox(features: readonly Feature<Polygon, unknown>[]): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    for (const ring of f.geometry.coordinates) {
      for (const [lon, lat] of ring) {
        if (lon < b[0]) b[0] = lon;
        if (lat < b[1]) b[1] = lat;
        if (lon > b[2]) b[2] = lon;
        if (lat > b[3]) b[3] = lat;
      }
    }
  }
  return b;
}

/** 外接矩形を度単位で広げる。0.002度 ≒ 200m */
function padBbox(b: Bbox, pad: number): Bbox {
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

export default function MapEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  /** チェックポイントのラベル。建物のラベルとは別に管理する */
  const cpMarkersRef = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  readyRef.current = ready;

  const [base, setBase] = useState<BaseId>("photo");
  /** 背景を暗くして通路を見やすくするか */
  const [dim, setDim] = useState(false);
  /** 地図の向き（度・時計回り）。0 が北。ボタンの表示に使う */
  const [bearing, setBearing] = useState(0);
  /**
   * パネルのタブ。
   * 建物が38件あると一覧だけで画面が埋まり、CPや接続のセクションが
   * 下に押し出されて見つけられなくなるため、切り替え式にする。
   */
  const [tab, setTab] = useState<"places" | "route" | "io">("places");
  /** ラベルの表示。点を密に置くと文字が重なって作業しにくいので個別に消せるようにする */
  const [showBuildingLabels, setShowBuildingLabels] = useState(true);
  const [showCpLabels, setShowCpLabels] = useState(true);
  const [mode, setMode] = useState<Mode>("none");
  const [draft, setDraft] = useState<Position[]>([]);
  const [data, setData] = useState<MapData>(EMPTY_DATA);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  /** 地図そのものが起動できなかったときの致命的エラー。画面に大きく出す */
  const [fatal, setFatal] = useState<string | null>(null);
  /** 基盤地図情報の読み込み中。90MB 級のファイルは数十秒かかる */
  const [busy, setBusy] = useState(false);
  /** 最後に自動保存した時刻。保存されている確証を画面に出すため */
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // クリックハンドラは1度しか登録しないため、最新の値を ref 経由で読む
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const dataRef = useRef(data);
  dataRef.current = data;
  /**
   * 地図のイベントハンドラ。
   * 登録は初期化時の1回だけなので、中身は ref に入れて毎回差し替える。
   * こうしないとホットリロード後も初回のコードが動き続ける。
   */
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => {});
  const moveRef = useRef<(e: MapMouseEvent) => void>(() => {});

  /** 直近の作図で吸着した回数。交差点がつながった手応えを出すため */
  const [snapCount, setSnapCount] = useState(0);
  /** 部屋のまとめ入力欄の中身 */
  const [roomInput, setRoomInput] = useState("");
  /** 接続モードで1つ目に選んだチェックポイント */
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const linkFromRef = useRef<string | null>(null);
  linkFromRef.current = linkFrom;
  /** 「この先の場所」を置くときの親チェックポイント */
  const [childParent, setChildParent] = useState<string | null>(null);
  const childParentRef = useRef<string | null>(null);
  childParentRef.current = childParent;

  /* ---------------- 初期化 ---------------- */

  useEffect(() => {
    setData(loadData());
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // 前の地図の canvas が残っていると重なって描画が崩れる。
    // ホットリロードで作り直されたときのために毎回きれいにする。
    containerRef.current.innerHTML = "";

    // MapLibre は WebGL2 を必要とする。使えない環境では地図が一切描画されないため、
    // 「真っ白で原因不明」にならないよう先に確認して画面に出す。
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) {
      const gl1 = probe.getContext("webgl") ?? probe.getContext("experimental-webgl");
      setFatal(
        gl1
          ? "この環境は WebGL1 までしか対応しておらず、地図を描画できません。ブラウザのハードウェアアクセラレーションを有効にするか、Chrome / Edge の最新版でお試しください。"
          : "WebGL が利用できないため地図を描画できません。ブラウザの設定でハードウェアアクセラレーションを有効にしてください（Chrome: 設定 → システム → 「ハードウェア アクセラレーションが使用可能な場合は使用する」）。",
      );
      return;
    }

    let map: MlMap;
    try {
      map = new MlMap({
        container: containerRef.current,
        center: INITIAL_VIEW.center,
        zoom: INITIAL_VIEW.zoom,
        maxZoom: 22,
        style: {
          version: 8,
          sources: Object.fromEntries(
            BASE_ORDER.map((id) => [
              `gsi-${id}`,
              {
                type: "raster",
                tiles: [BASES[id].url],
                tileSize: BASES[id].tileSize,
                maxzoom: BASES[id].maxzoom,
                attribution: GSI_ATTRIBUTION,
              },
            ]),
          ) as never,
          // 初期表示の可視性はここで確定させる。
          // 「load後にエフェクトで切り替える」だけに頼ると、load前に失敗したとき地図が真っ白になる
          layers: BASE_ORDER.map((id) => ({
            id: `base-${id}`,
            type: "raster",
            source: `gsi-${id}`,
            layout: { visibility: id === "photo" ? "visible" : "none" },
          })) as never,
        },
      });
    } catch (err) {
      console.error("[maplibre init]", err);
      setFatal(
        `地図の初期化に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    map.on("error", (e) => {
      console.error("[maplibre]", e.error ?? e);
      setNotice({
        kind: "warn",
        text: `地図でエラーが発生しました: ${e.error?.message ?? "詳細不明"}`,
      });
    });

    // 右クリックドラッグでも回せるので、その結果もボタンの表示に反映する
    map.on("rotate", () => setBearing(map.getBearing()));

    map.addControl(new NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

    map.on("load", () => {
      // レイヤ定義の1つが例外を投げると、以降のレイヤが全て作られないまま
      // 無言で終わる（実際にそれで CP が押せない不具合が出た）。
      // まとめて捕まえて画面に出す。
      try {
        buildLayers(map);
        console.log("[layers] 作成完了");
        setReady(true);
      } catch (err) {
        console.error("[layers] 途中で失敗", err);
        setFatal(
          `地図のレイヤを作成できませんでした: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    function buildLayers(map: MlMap) {
      const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
      map.addSource("campus", { type: "geojson", data: empty });
      map.addSource("buildings", { type: "geojson", data: empty });
      map.addSource("draft", { type: "geojson", data: empty });

      map.addLayer({
        id: "campus-fill",
        type: "fill",
        source: "campus",
        paint: { "fill-color": "#22c55e", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "campus-line",
        type: "line",
        source: "campus",
        paint: { "line-color": "#16a34a", "line-width": 3, "line-dasharray": [2, 1] },
      });

      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["get", "isSelected"], false],
            "#f97316",
            categoryColorExpr("color"),
          ],
          // 航空写真を透かして見せたいので薄く重ねる
          "fill-opacity": 0.35,
        },
      });
      map.addLayer({
        id: "buildings-line",
        type: "line",
        source: "buildings",
        paint: {
          "line-color": [
            "case",
            ["boolean", ["get", "isSelected"], false],
            "#ea580c",
            categoryColorExpr("lineColor"),
          ],
          "line-width": 2,
        },
      });

      // 通路。建物の上に描く（線が建物に隠れないように）
      map.addSource("paths", { type: "geojson", data: empty });
      // 濃い縁取りを下に敷く。航空写真の上でも線が埋もれない
      map.addLayer({
        id: "paths-casing",
        type: "line",
        source: "paths",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#1e293b",
          "line-width": ["+", pathKindExpr("width"), 4],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "paths-line",
        type: "line",
        source: "paths",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["get", "isSelected"], false],
            "#f97316",
            // 案内に使わない通路は灰色にして、ひと目で区別できるようにする
            ["!", ["boolean", ["get", "enabled"], true]],
            "#94a3b8",
            pathKindExpr("color"),
          ],
          "line-width": pathKindExpr("width"),
        },
      });
      // 同上。除外中の参考線は別レイヤで破線にする
      map.addLayer({
        id: "paths-disabled",
        type: "line",
        source: "paths",
        filter: ["!", ["boolean", ["get", "enabled"], true]],
        layout: { "line-cap": "butt" },
        paint: {
          "line-color": "#e2e8f0",
          "line-width": pathKindExpr("width"),
          "line-dasharray": [2, 2],
        },
      });
      // 屋根付きは白い破線を重ねて区別する
      map.addLayer({
        id: "paths-roofed",
        type: "line",
        source: "paths",
        filter: ["boolean", ["get", "roofed"], false],
        layout: { "line-cap": "butt" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 1.5,
          "line-dasharray": [2, 2],
        },
      });
      // 全頂点。網目の骨組みが見えるようにする
      map.addSource("path-verts", { type: "geojson", data: empty });
      map.addLayer({
        id: "path-verts-circle",
        type: "circle",
        source: "path-verts",
        minzoom: 16,
        paint: {
          "circle-radius": 2.5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1e293b",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      });

      // 端点。つながっているかを目で確認できるようにする
      map.addSource("path-ends", { type: "geojson", data: empty });
      map.addLayer({
        id: "path-ends-circle",
        type: "circle",
        source: "path-ends",
        paint: {
          "circle-radius": ["case", ["boolean", ["get", "dangling"], false], 7, 4.5],
          "circle-color": [
            "case",
            ["boolean", ["get", "dangling"], false],
            "#ef4444",
            "#22c55e",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      // 接続（経路グラフの辺）。ここだけが案内で通れる区間になる
      map.addSource("links", { type: "geojson", data: empty });
      map.addLayer({
        id: "links-casing",
        type: "line",
        source: "links",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0f172a",
          "line-width": ["+", pathKindExpr("width"), 7],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "links-line",
        type: "line",
        source: "links",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["get", "isSelected"], false],
            "#f97316",
            ["!", ["boolean", ["get", "enabled"], true]],
            "#94a3b8",
            pathKindExpr("color"),
          ],
          // 経路グラフは作図の主役なので、下書きの通路線より太くする
          "line-width": ["+", pathKindExpr("width"), 2.5],
        },
      });
      // ★ line-dasharray はデータ依存の式を受け付けない（addLayer が例外を投げ、
      //    以降のレイヤが全て作られなくなる）。除外中の表現は別レイヤで重ねる。
      map.addLayer({
        id: "links-disabled",
        type: "line",
        source: "links",
        filter: ["!", ["boolean", ["get", "enabled"], true]],
        layout: { "line-cap": "butt" },
        paint: {
          "line-color": "#e2e8f0",
          "line-width": ["+", pathKindExpr("width"), 2.5],
          "line-dasharray": [2, 2],
        },
      });

      // 接続中に「今どこへつなごうとしているか」を出す。
      // 押した点とカーソルの間に線を引くと、操作している実感が出る
      map.addSource("link-preview", { type: "geojson", data: empty });
      map.addLayer({
        id: "link-preview-line",
        type: "line",
        source: "link-preview",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": "#0ea5e9",
          "line-width": 3,
          "line-dasharray": [2, 1.5],
          "line-opacity": 0.9,
        },
      });

      // 親子関係。「ここを通らないと入れない」を表す線。
      // 屋外の接続とは意味が違うので、紫の点線で区別する
      map.addSource("hier", { type: "geojson", data: empty });
      map.addLayer({
        id: "hier-line",
        type: "line",
        source: "hier",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": "#7c3aed",
          "line-width": 2.5,
          "line-dasharray": [1, 1.5],
          "line-opacity": 0.9,
        },
      });

      // チェックポイントの到着判定範囲。実距離で見せたいので面で描く
      map.addSource("cp-area", { type: "geojson", data: empty });
      map.addLayer({
        id: "cp-area-fill",
        type: "fill",
        source: "cp-area",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "cp-area-line",
        type: "line",
        source: "cp-area",
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.5,
          "line-dasharray": [3, 2],
        },
      });

      map.addSource("checkpoints", { type: "geojson", data: empty });
      map.addLayer({
        id: "cp-circle",
        type: "circle",
        source: "checkpoints",
        paint: {
          // 深い階層ほど小さく描き、外から入れる点（レベル1）を目立たせる
          "circle-radius": [
            "case",
            ["boolean", ["get", "isSelected"], false],
            9,
            ["==", ["get", "level"], 1],
            6,
            4.5,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-color": [
            "case",
            ["boolean", ["get", "isSelected"], false],
            "#ea580c",
            ["==", ["get", "level"], 1],
            "#ffffff",
            "#7c3aed",
          ],
          "circle-stroke-width": 2.5,
        },
      });

      map.addLayer({
        id: "draft-fill",
        type: "fill",
        source: "draft",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#ef4444", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: "draft-line",
        type: "line",
        source: "draft",
        filter: ["!=", ["geometry-type"], "Point"],
        paint: { "line-color": "#ef4444", "line-width": 2 },
      });
      map.addLayer({
        id: "draft-vertex",
        type: "circle",
        source: "draft",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#ef4444",
          "circle-stroke-width": 2,
        },
      });
    }

    // ★ハンドラは ref 経由で呼ぶ。
    //   この効果は依存配列が空で一度しか走らないため、直接登録すると
    //   ホットリロード後も初回のコードが動き続け、修正が反映されない。
    //   中身は毎回の描画で差し替える（下の handleMapClick / handleMapMove）。
    map.on("click", (e) => clickRef.current(e));
    map.on("mousemove", (e) => moveRef.current(e));

    // 置き場所の大きさが変わったら地図に測り直させる。
    // ウィンドウのリサイズだけでなく、初回描画直後にレイアウトが確定する場合にも効く。
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    mapRef.current = map;
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* ---------------- 地図の操作 ---------------- */

  /**
   * 地図のクリック。毎回の描画で ref に入れ直すので、
   * ホットリロードでも常に最新のコードが動く。
   */
  clickRef.current = (e: MapMouseEvent) => {
    const map = mapRef.current;
    if (!map) return;
    {
      const pt: Position = [e.lngLat.lng, e.lngLat.lat];

      if (modeRef.current === "none") {
        // 小さいものから順に判定する（狙って押しているはずなので）
        const nearCp = nearestCp(
          map,
          e.point,
          dataRef.current.checkpoints.features as CheckpointFeature[],
        );
        if (nearCp) {
          setSelected(nearCp.properties.id);
          return;
        }
        const hitLink = map.queryRenderedFeatures(e.point, { layers: ["links-line"] });
        if (hitLink.length) {
          setSelected(String(hitLink[0].properties?.id ?? ""));
          return;
        }
        const hitPath = map.queryRenderedFeatures(e.point, { layers: ["paths-line"] });
        if (hitPath.length) {
          setSelected(String(hitPath[0].properties?.id ?? ""));
          return;
        }
        const hit = map.queryRenderedFeatures(e.point, { layers: ["buildings-fill"] });
        setSelected(hit.length ? String(hit[0].properties?.tempId ?? "") : null);
        return;
      }

      if (modeRef.current === "link") {
        // チェックポイントを2つ順に押すと、その間に接続を作る
        const near = nearestCp(
          map,
          e.point,
          dataRef.current.checkpoints.features as CheckpointFeature[],
        );
        if (!near) {
          setNotice({
            kind: "warn",
            text: "近くにチェックポイントがありません。丸の近くをクリックしてください。",
          });
          return;
        }
        const id = near.properties.id;
        const from = linkFromRef.current;

        if (!from) {
          setLinkFrom(id);
          return;
        }
        if (from === id) {
          setLinkFrom(null);
          return;
        }

        setData((prev) => {
          // 同じ組み合わせが既にあれば増やさない（向きは問わない）
          const exists = prev.links.some(
            (l) =>
              (l.from === from && l.to === id) || (l.from === id && l.to === from),
          );
          if (exists) {
            setNotice({ kind: "warn", text: `${from} と ${id} は既につながっています。` });
            return prev;
          }
          // つながった手応えを出す。距離も一緒に見せる
          const a = prev.checkpoints.features.find((c) => c.properties.id === from);
          const b = prev.checkpoints.features.find((c) => c.properties.id === id);
          const m =
            a && b ? Math.round(metersBetween(a.geometry.coordinates, b.geometry.coordinates)) : 0;
          setNotice({
            kind: "ok",
            text: `${from} ━ ${id} をつなぎました（${m}m）。接続 ${prev.links.length + 1} 本目。`,
          });
          return {
            ...prev,
            links: [
              ...prev.links,
              {
                id: nextLinkId(prev.links),
                from,
                to: id,
                kind: "normal",
                roofed: false,
                enabled: true,
                note: "",
              },
            ],
          };
        });
        // 続けて次の区間を引けるよう、今つないだ先を起点にする
        setLinkFrom(id);
        return;
      }

      if (modeRef.current === "checkpoint" || modeRef.current === "child") {
        // 1クリックで1個置く。通路の頂点に吸着させて、経路グラフに確実に乗せる
        const { pos } = snapToVertices(
          pt,
          dataRef.current.paths.features as PathFeature[],
          [],
          SNAP_METERS,
        );
        const cpsNow = dataRef.current.checkpoints.features as CheckpointFeature[];
        const id = nextCheckpointId(cpsNow);

        // 「この先の場所」として置く場合は、親を通らないと入れない子にする
        const parentId = modeRef.current === "child" ? childParentRef.current : null;
        const parent = parentId
          ? cpsNow.find((c) => c.properties.id === parentId)
          : undefined;

        const props: CheckpointProps = {
          id,
          kind: parent ? "waypoint" : "entrance",
          name: "",
          linkedTo: "",
          radius: parent ? CHECKPOINT_KINDS[2].radius : CHECKPOINT_KINDS[0].radius,
          note: "",
          level: parent ? parent.properties.level + 1 : 1,
          parents: parent ? [parent.properties.id] : [],
        };
        setData((prev) => ({
          ...prev,
          checkpoints: {
            type: "FeatureCollection",
            features: [
              ...prev.checkpoints.features,
              { type: "Feature", geometry: { type: "Point", coordinates: pos }, properties: props },
            ],
          },
        }));
        // 置いた直後に名前と対象を入れられるよう選択しておく
        setSelected(id);
        return;
      }

      if (modeRef.current === "path") {
        // 既存の通路の頂点に吸着させる。1m のズレでも経路が大回りするため
        setDraft((prev) => {
          const { pos, snapped } = snapToVertices(
            pt,
            dataRef.current.paths.features as PathFeature[],
            prev,
            SNAP_METERS,
          );
          if (snapped) setSnapCount((n) => n + 1);
          return [...prev, pos];
        });
        return;
      }

      setDraft((prev) => [...prev, pt]);
    }
  };

  /** マウス移動。接続中の線と、カーソルの形を出す */
  moveRef.current = (e: MapMouseEvent) => {
    const map = mapRef.current;
    if (!map) return;
    {
      // 接続の起点を押した後は、カーソルまで線を伸ばして見せる
      if (modeRef.current === "link") {
        map.getCanvas().style.cursor = "crosshair";
        const from = linkFromRef.current;
        const a = from
          ? (dataRef.current.checkpoints.features as CheckpointFeature[]).find(
              (c) => c.properties.id === from,
            )?.geometry.coordinates
          : undefined;
        (map.getSource("link-preview") as GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features: a
            ? [
                {
                  type: "Feature",
                  geometry: {
                    type: "LineString",
                    coordinates: [a, [e.lngLat.lng, e.lngLat.lat]],
                  },
                  properties: {},
                },
              ]
            : [],
        });
        return;
      }
      if (modeRef.current !== "none") {
        map.getCanvas().style.cursor = "crosshair";
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, {
        layers: ["buildings-fill", "paths-line", "links-line", "cp-circle"],
      });
      map.getCanvas().style.cursor = hit.length ? "pointer" : "";
    }
  };

  /* ---------------- ベースマップ切替 ---------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const id of BASE_ORDER) {
      map.setLayoutProperty(`base-${id}`, "visibility", id === base ? "visible" : "none");
      // 航空写真は情報量が多く、通路の線が埋もれる。
      // 暗くして彩度を落とすと、上に乗せた線と建物だけが浮かび上がる
      map.setPaintProperty(`base-${id}`, "raster-brightness-max", dim ? 0.45 : 1);
      map.setPaintProperty(`base-${id}`, "raster-saturation", dim ? -0.6 : 0);
    }
  }, [base, ready, dim]);

  /* ---------------- データ反映 ---------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    /**
     * スタイルの読み込みが終わっていないと setData が描画に反映されない。
     * 一度実行し、まだなら落ち着いた時点（idle）でもう一度実行する。
     */
    const apply = () => {
    (map.getSource("campus") as GeoJSONSource)?.setData(data.campus);

    (map.getSource("paths") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: data.paths.features.map((f) => ({
        ...f,
        properties: { ...f.properties, isSelected: f.properties.id === selected },
      })),
    });

    // 全頂点。網目の形が見えるようにする
    (map.getSource("path-verts") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: data.paths.features.flatMap((f) =>
        f.geometry.coordinates.map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: p },
          properties: {},
        })),
      ),
    });

    // 端点を点として出す。つながっていない端点は赤く大きく表示して気づけるようにする
    const dangling = findDangling(data.paths.features as PathFeature[]);
    const isDangling = (p: Position) =>
      dangling.some((d) => d[0] === p[0] && d[1] === p[1]);
    (map.getSource("path-ends") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: data.paths.features.flatMap((f) => {
        const c = f.geometry.coordinates;
        if (c.length < 2) return [];
        return [c[0], c[c.length - 1]].map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: p },
          properties: { dangling: isDangling(p) },
        }));
      }),
    });

    // 選択状態を描画に反映するため、properties に isSelected を注入したコピーを渡す
    (map.getSource("buildings") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: data.buildings.features.map((f) => ({
        ...f,
        properties: { ...f.properties, isSelected: f.properties.tempId === selected },
      })),
    });

    // チェックポイントと、その到着判定範囲
    const cps = data.checkpoints.features as CheckpointFeature[];
    const cpPos = new Map(cps.map((f) => [f.properties.id, f.geometry.coordinates]));

    const cpFc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: cps.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          color: checkpointKindOf(f.properties.kind).color,
          isSelected: f.properties.id === selected || f.properties.id === linkFrom,
        },
      })),
    };
    const cpSrc = map.getSource("checkpoints") as GeoJSONSource | undefined;
    // ?. で握り潰すと「何も起きない」だけになるので、欠けていたら記録する
    if (!cpSrc) {
      console.error("[CP] ソース checkpoints が存在しません", {
        sources: Object.keys(map.getStyle()?.sources ?? {}),
        layers: (map.getStyle()?.layers ?? []).map((l) => l.id),
      });
    } else {
      cpSrc.setData(cpFc);
      // 操作している地図が本当に画面に出ているものか確かめる。
      // 古い地図オブジェクトを掴んでいると、setData は成功するのに何も描かれない。
      const el = map.getContainer();
      console.log("[CP] setData", {
        送った件数: cpFc.features.length,
        画面にある: typeof document !== "undefined" && document.body.contains(el),
        canvas: `${map.getCanvas().clientWidth}x${map.getCanvas().clientHeight}`,
        loaded: map.loaded(),
        styleLoaded: map.isStyleLoaded(),
        レイヤ数: map.getStyle()?.layers?.length ?? -1,
        建物描画数: map.queryRenderedFeatures({ layers: ["buildings-fill"] }).length,
      });
    }

    // 親子関係の線。子から各親へ引く（親が複数ならその数だけ出る）
    (map.getSource("hier") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: cps.flatMap((c) =>
        c.properties.parents.flatMap((pid) => {
          const a = cpPos.get(pid);
          const b = c.geometry.coordinates;
          if (!a) return [];
          return [
            {
              type: "Feature" as const,
              geometry: { type: "LineString" as const, coordinates: [a, b] },
              properties: { from: pid, to: c.properties.id },
            },
          ];
        }),
      ),
    });

    // 接続の線はチェックポイントの座標から毎回作る。点を動かしても線がずれない
    const linkFeatures = data.links.flatMap((l) => {
      const a = cpPos.get(l.from);
      const b = cpPos.get(l.to);
      if (!a || !b) return []; // 片方が削除済み
      return [
        {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: [a, b] },
          properties: { ...l, isSelected: l.id === selected },
        },
      ];
    });
    if (data.links.length > 0) {
      console.log("[LINK] draw", {
        links: data.links.length,
        drawn: linkFeatures.length,
        layer: !!map.getLayer("links-line"),
      });
    }
    (map.getSource("links") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: linkFeatures,
    });
    if (cps.length > 0) {
      // ソースに入っている数と、実際に描画されている数を比べる。
      // 前者だけ多いなら描画（paint 定義）の問題、両方0ならデータが届いていない。
      requestAnimationFrame(() => {
        try {
          console.log("[CP] draw", {
            cps: cps.length,
            links: data.links.length,
            cpInSource: map.querySourceFeatures("checkpoints").length,
            cpRendered: map.queryRenderedFeatures({ layers: ["cp-circle"] }).length,
            linkInSource: map.querySourceFeatures("links").length,
            linkRendered: map.queryRenderedFeatures({ layers: ["links-line"] }).length,
          });
        } catch (err) {
          console.log("[CP] draw 失敗", String(err));
        }
      });
    }
    (map.getSource("cp-area") as GeoJSONSource)?.setData({
      type: "FeatureCollection",
      features: cps.map((f) => ({
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [circlePolygon(f.geometry.coordinates, f.properties.radius)],
        },
        properties: { color: checkpointKindOf(f.properties.kind).color },
      })),
    });

    // ラベルは HTML マーカーで出す（ラスタのみのスタイルには glyphs が無いため）
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = !showBuildingLabels ? [] : data.buildings.features.map((f) => {
      const cat = categoryOf(f.properties.category);
      const el = document.createElement("div");
      el.textContent = buildingLabel(f.properties);
      el.className =
        "px-1.5 py-0.5 rounded text-[11px] font-bold leading-none whitespace-nowrap " +
        "shadow-sm pointer-events-none border";
      // 名称が入っているものは種別色で塗り、未入力のものは白地にして区別する
      if (isNamed(f.properties)) {
        el.style.backgroundColor = cat.color;
        el.style.borderColor = cat.lineColor;
        el.style.color = cat.textColor;
      } else {
        el.style.backgroundColor = "rgba(255,255,255,0.7)";
        el.style.borderColor = cat.lineColor;
        el.style.color = cat.lineColor;
      }
      return new Marker({ element: el })
        .setLngLat(ringCenter(f.geometry.coordinates[0]))
        .addTo(map);
    });

    // チェックポイントのラベル。どの点がどれか地図上で見分けられるようにする。
    // 点が重なって読めなくならないよう、丸の少し上に小さく出す。
    cpMarkersRef.current.forEach((m) => m.remove());
    cpMarkersRef.current = !showCpLabels ? [] : cps.map((f) => {
      const k = checkpointKindOf(f.properties.kind);
      const el = document.createElement("div");
      el.textContent = f.properties.name || f.properties.id;
      el.className =
        "px-1 py-0.5 rounded text-[10px] font-bold leading-none whitespace-nowrap " +
        "shadow-sm pointer-events-none border";
      const on = f.properties.id === selected || f.properties.id === linkFrom;
      el.style.backgroundColor = on ? "#ea580c" : "rgba(255,255,255,0.92)";
      el.style.borderColor = on ? "#ea580c" : k.color;
      el.style.color = on ? "#ffffff" : k.color;
      return new Marker({ element: el, offset: [0, -14] })
        .setLngLat(f.geometry.coordinates as [number, number])
        .addTo(map);
    });
    };

    apply();
    // まだ読み込み中なら、落ち着いた時点でもう一度入れ直す。
    // これが無いと、初回に渡したデータが反映されないまま残る。
    if (!map.isStyleLoaded()) {
      map.once("idle", apply);
      return () => {
        map.off("idle", apply);
      };
    }
  }, [data, selected, ready, linkFrom, showBuildingLabels, showCpLabels]);

  /* ---------------- 地図の上に重ねる描画 ---------------- */

  /**
   * MapLibre のレイヤ経由の描画が反映されないため、
   * CPと接続だけは地図の上に SVG を重ねて自前で描く。
   * 地図が動くたびに座標を計算し直す。
   */
  const [viewTick, setViewTick] = useState(0);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const bump = () => setViewTick((v) => v + 1);
    for (const ev of ["move", "zoom", "rotate", "resize", "load"] as const) {
      map.on(ev, bump);
    }
    bump();
    return () => {
      for (const ev of ["move", "zoom", "rotate", "resize", "load"] as const) {
        map.off(ev, bump);
      }
    };
  }, [ready]);

  /** 画面座標に変換したCPと接続。viewTick が変わるたびに作り直す */
  const overlay = useMemo(() => {
    const map = mapRef.current;
    if (!map || !ready) return null;
    void viewTick; // 地図が動いたら作り直すための依存

    const cps = data.checkpoints.features as CheckpointFeature[];
    const pos = new Map<string, { x: number; y: number }>();
    for (const c of cps) {
      const [lon, lat] = c.geometry.coordinates;
      const p = map.project([lon, lat]);
      pos.set(c.properties.id, { x: p.x, y: p.y });
    }

    const lines = data.links.flatMap((l) => {
      const a = pos.get(l.from);
      const b = pos.get(l.to);
      if (!a || !b) return [];
      return [{ l, a, b }];
    });

    const hier = cps.flatMap((c) =>
      c.properties.parents.flatMap((pid) => {
        const a = pos.get(pid);
        const b = pos.get(c.properties.id);
        return a && b ? [{ a, b, key: `${pid}-${c.properties.id}` }] : [];
      }),
    );

    return { cps, pos, lines, hier };
  }, [data.checkpoints.features, data.links, ready, viewTick]);

  /** 選んだものに応じてタブを切り替える。編集欄が隠れたままにならないように */
  useEffect(() => {
    if (!selected) return;
    if (selected.startsWith("B-")) setTab("places");
    else if (selected.startsWith("C-") || selected.startsWith("L-")) setTab("route");
    else if (selected.startsWith("P-")) setTab("route");
  }, [selected]);

  /** 接続モードを抜けたら、伸ばしかけの線を消す */
  useEffect(() => {
    if (mode === "link" && linkFrom) return;
    const src = mapRef.current?.getSource("link-preview") as GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: [] });
  }, [mode, linkFrom]);

  /** モードに応じてもタブを合わせる */
  useEffect(() => {
    if (mode === "checkpoint" || mode === "child" || mode === "link" || mode === "path") {
      setTab("route");
    } else if (mode === "building" || mode === "campus") {
      setTab("places");
    }
  }, [mode]);

  /* ---------------- 自動保存 ---------------- */

  /**
   * 保存は地図の描画と切り離す。
   * 以前は描画エフェクトの末尾で保存していたため、地図が準備できていないと
   * （`!ready` で早期 return され）作図内容が一切保存されなかった。
   *
   * 初期値 EMPTY_DATA のままのときは書き込まない。
   * 読み込み前に空で上書きしてしまうのを防ぐため。
   */
  useEffect(() => {
    if (data === EMPTY_DATA) return;
    saveData(data);
    setSavedAt(new Date());
  }, [data]);

  /* ---------------- 作図中の表示 ---------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("draft") as GeoJSONSource | undefined;
    if (!src) return;

    const features: GeoJSON.Feature[] = draft.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
      properties: {},
    }));
    // 通路は閉じないので常に線。敷地・場所は3点以上で面にする
    if (mode === "path") {
      if (draft.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: draft },
          properties: {},
        });
      }
    } else if (draft.length >= 3) {
      features.push({ type: "Feature", geometry: toPolygon(draft), properties: {} });
    } else if (draft.length === 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: draft },
        properties: {},
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }, [draft, ready, mode]);

  /* ---------------- 操作 ---------------- */

  const finish = useCallback(() => {
    // 通路は2点から成立する。面は3点必要
    const min = modeRef.current === "path" ? 2 : 3;
    if (draft.length < min) return;

    if (modeRef.current === "path") {
      let pathId: string | null = null;
      setData((prev) => {
        const id = nextPathId(prev.paths.features as PathFeature[]);
        pathId = id;
        return {
          ...prev,
          paths: {
            type: "FeatureCollection",
            features: [
              ...prev.paths.features,
              {
                type: "Feature",
                geometry: { type: "LineString", coordinates: draft },
                properties: { id, kind: "normal", roofed: false, enabled: true, note: "" },
              },
            ],
          },
        };
      });
      setDraft([]);
      setMode("none");
      if (pathId) setSelected(pathId);
      return;
    }

    const geometry = toPolygon(draft);
    let newId: string | null = null;

    setData((prev) => {
      if (modeRef.current === "campus") {
        return {
          ...prev,
          campus: {
            type: "FeatureCollection",
            features: [
              ...prev.campus.features,
              { type: "Feature", geometry, properties: { name: "キャンパス敷地" } },
            ],
          },
        };
      }
      const tempId = nextTempId(prev.buildings.features as BuildingFeature[]);
      // 種別は未分類で作る。描いた直後に選んでもらう（号館とは限らないため）
      newId = tempId;
      return {
        ...prev,
        buildings: {
          type: "FeatureCollection",
          features: [
            ...prev.buildings.features,
            {
              type: "Feature",
              geometry,
              properties: { tempId, category: "other", code: "", name: "", floors: 0, note: "" },
            },
          ],
        },
      };
    });
    setDraft([]);
    setMode("none");
    // 描いたらそのまま編集できるよう選択状態にする
    if (newId) setSelected(newId);
  }, [draft]);

  const cancel = useCallback(() => {
    setDraft([]);
    setMode("none");
    setLinkFrom(null);
    setChildParent(null);
  }, []);

  /**
   * 建物をまとめて削除する。
   * 範囲違いのメッシュを取り込んでしまうと数百件入るため、1件ずつでは戻せない。
   */
  const clearBuildings = () => {
    const n = data.buildings.features.length;
    if (!window.confirm(`建物 ${n} 件をすべて削除します。よろしいですか？`)) return;
    setData((prev) => ({ ...prev, buildings: { type: "FeatureCollection", features: [] } }));
    setSelected(null);
    setNotice({ kind: "ok", text: `建物 ${n} 件を削除しました。取り込みをやり直せます。` });
  };

  /**
   * 扇が丘キャンパスを大きめに囲む矩形を敷地として登録する。
   * 地図が表示できない環境でも基盤地図情報の取り込みに進めるようにするための逃げ道。
   */
  const addRoughCampus = () => {
    const [w, s, e, n] = CAMPUS_ROUGH_BBOX;
    setData((prev) => ({
      ...prev,
      campus: {
        type: "FeatureCollection",
        features: [
          ...prev.campus.features,
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [w, s],
                  [e, s],
                  [e, n],
                  [w, n],
                  [w, s],
                ],
              ],
            },
            properties: { name: "仮の敷地（矩形・要修正）" },
          },
        ],
      },
    }));
    setNotice({
      kind: "ok",
      text: "仮の敷地（約1.1km四方の矩形）を作りました。取り込みに進めます。正確な敷地は後で描き直してください。",
    });
  };

  const undoPoint = useCallback(() => setDraft((p) => p.slice(0, -1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      if (e.key === "Enter" && modeRef.current !== "none") finish();
      if (e.key === "Backspace" && modeRef.current !== "none") {
        e.preventDefault();
        undoPoint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, finish, undoPoint]);

  const updateBuilding = (tempId: string, patch: Partial<BuildingProps>) => {
    setData((prev) => ({
      ...prev,
      buildings: {
        type: "FeatureCollection",
        features: prev.buildings.features.map((f) =>
          f.properties.tempId === tempId
            ? { ...f, properties: { ...f.properties, ...patch } }
            : f,
        ),
      },
    }));
  };

  const removeBuilding = (tempId: string) => {
    setData((prev) => ({
      ...prev,
      buildings: {
        type: "FeatureCollection",
        features: prev.buildings.features.filter((f) => f.properties.tempId !== tempId),
      },
    }));
    setSelected(null);
  };

  const removeCampus = (index: number) => {
    setData((prev) => ({
      ...prev,
      campus: {
        type: "FeatureCollection",
        features: prev.campus.features.filter((_, i) => i !== index),
      },
    }));
  };

  const flyTo = (f: BuildingFeature) => {
    mapRef.current?.flyTo({ center: ringCenter(f.geometry.coordinates[0]), zoom: 18 });
    setSelected(f.properties.tempId);
  };

  /** 地図の向きを変える。角度は度、時計回りが正 */
  const rotateBy = (deg: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ bearing: map.getBearing() + deg, duration: 200 });
  };

  /** 北を上に戻す */
  const resetNorth = () => {
    mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 300 });
  };

  /** チェックポイントの位置へ地図を動かす。一覧から場所を確かめるため */
  const flyToCp = (f: CheckpointFeature) => {
    const [lon, lat] = f.geometry.coordinates;
    mapRef.current?.flyTo({ center: [lon, lat], zoom: 19 });
    setSelected(f.properties.id);
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.campus && parsed.buildings) {
      setData(parsed as MapData);
      return;
    }
    // 点だけの FeatureCollection はチェックポイント
    if (parsed.type === "FeatureCollection" && parsed.features?.[0]?.geometry?.type === "Point") {
      setData((prev) => ({ ...prev, checkpoints: parsed }));
      return;
    }
    // rooms.json は配列で書き出している
    if (Array.isArray(parsed)) {
      setData((prev) => ({ ...prev, rooms: parsed as Room[] }));
      return;
    }
    // 単体の FeatureCollection の場合は中身から振り分ける
    if (parsed.type === "FeatureCollection") {
      const p = parsed.features?.[0]?.properties ?? {};
      const isPath = parsed.features?.[0]?.geometry?.type === "LineString" || p.kind !== undefined;
      const isBuilding = p.tempId !== undefined;
      setData((prev) => {
        if (isPath) return { ...prev, paths: parsed };
        if (isBuilding) return { ...prev, buildings: parsed };
        return { ...prev, campus: parsed };
      });
    }
  };

  /**
   * 基盤地図情報の建築物データを取り込む。
   * 敷地ポリゴンの内側にある建物だけを残す（＝大学1つ分だけを切り出す）。
   */
  const importFgd = async (files: File[]) => {
    if (data.campus.features.length === 0) {
      setNotice({
        kind: "warn",
        text: "先に敷地を描いてください。敷地の内側にある建物だけを取り込みます。",
      });
      return;
    }

    // メッシュ1枚の BldA は 90MB／数十万棟ある。敷地の外接矩形を先に渡して
    // 読み捨てさせないとメモリが持たない。少し広げて境界上の建物を落とさない。
    const bbox = padBbox(campusBbox(data.campus.features), 0.002);

    setBusy(true);
    setNotice({ kind: "ok", text: `${files.length} 件を読み込み中… （数十秒かかることがあります）` });
    await new Promise((r) => setTimeout(r, 50)); // 画面を描き直させてから重い処理に入る

    let all: FgdBuilding[] = [];
    let scanned = 0;
    let firstCoord: Position | null = null;
    try {
      for (const f of files) {
        const r = parseFgdBuildings(await f.text(), bbox);
        all = all.concat(r.buildings);
        scanned += r.scanned;
        firstCoord ??= r.firstCoord;
      }
    } catch (e) {
      setNotice({ kind: "warn", text: e instanceof Error ? e.message : "読み込みに失敗しました" });
      return;
    } finally {
      setBusy(false);
    }

    const problem = sanityCheck({ buildings: all, scanned, firstCoord });
    if (problem) {
      setNotice({ kind: "warn", text: problem });
      return;
    }

    // 建物の中心が敷地内にあるものだけを採用する。
    // 「交差」ではなく「中心」で判定することで、道路を挟んだ隣接建物を拾わない。
    const kept = all.filter((b) => {
      const c = turfPoint(ringCenter(b.ring));
      return data.campus.features.some((cf) => booleanPointInPolygon(c, cf));
    });

    if (kept.length === 0) {
      setNotice({
        kind: "warn",
        text: `建物 ${scanned.toLocaleString()} 件を読みましたが、敷地内に該当なし。ファイルの対象メッシュが敷地とずれている可能性があります。`,
      });
      return;
    }

    setData((prev) => {
      const features = [...prev.buildings.features];
      for (const b of kept) {
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [b.ring] },
          properties: {
            tempId: nextTempId(features as BuildingFeature[]),
            // 取り込み元は「建築物」データなので号館を既定にする。
            // 図書館などは選び直す（屋外設備はこのデータには入っていない）
            category: "hall",
            code: "",
            name: "",
            floors: 0,
            note: b.type,
          },
        });
      }
      return { ...prev, buildings: { type: "FeatureCollection", features } };
    });

    setNotice({
      kind: "ok",
      text: `建物 ${scanned.toLocaleString()} 件を走査し、敷地内の ${kept.length} 件を取り込みました。`,
    });
  };

  const selectedFeature = useMemo(
    () =>
      (data.buildings.features as BuildingFeature[]).find(
        (f) => f.properties.tempId === selected,
      ) ?? null,
    [data.buildings.features, selected],
  );

  const selectedPath = useMemo(
    () => (data.paths.features as PathFeature[]).find((f) => f.properties.id === selected) ?? null,
    [data.paths.features, selected],
  );

  /** つながっていない端点。ここが残っていると経路が大回りする */
  const dangling = useMemo(
    () => findDangling(data.paths.features as PathFeature[]),
    [data.paths.features],
  );

  const selectedCp = useMemo(
    () =>
      (data.checkpoints.features as CheckpointFeature[]).find(
        (f) => f.properties.id === selected,
      ) ?? null,
    [data.checkpoints.features, selected],
  );

  const updateCp = (id: string, patch: Partial<CheckpointProps>) => {
    setData((prev) => ({
      ...prev,
      checkpoints: {
        type: "FeatureCollection",
        features: prev.checkpoints.features.map((f) =>
          f.properties.id === id ? { ...f, properties: { ...f.properties, ...patch } } : f,
        ),
      },
    }));
  };

  const removeCp = (id: string) => {
    setData((prev) => ({
      ...prev,
      checkpoints: {
        type: "FeatureCollection",
        features: prev.checkpoints.features
          .filter((f) => f.properties.id !== id)
          // 削除したCPを親に持つ子から、その親を外す。
          // 残しておくと存在しない親を指したままになる
          .map((f) =>
            f.properties.parents.includes(id)
              ? {
                  ...f,
                  properties: {
                    ...f.properties,
                    parents: f.properties.parents.filter((p) => p !== id),
                  },
                }
              : f,
          ),
      },
      // 削除したCPにつながっていた接続も消す
      links: prev.links.filter((l) => l.from !== id && l.to !== id),
    }));
    setSelected(null);
  };

  const selectedLink = useMemo(
    () => data.links.find((l) => l.id === selected) ?? null,
    [data.links, selected],
  );

  const updateLink = (id: string, patch: Partial<LinkProps>) => {
    setData((prev) => ({
      ...prev,
      links: prev.links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  };

  const removeLink = (id: string) => {
    setData((prev) => ({ ...prev, links: prev.links.filter((l) => l.id !== id) }));
    setSelected(null);
  };

  /** チェックポイントIDから座標を引く */
  const cpById = useMemo(
    () =>
      new Map(
        (data.checkpoints.features as CheckpointFeature[]).map((f) => [f.properties.id, f]),
      ),
    [data.checkpoints.features],
  );

  /** 経路グラフがひと続きになっているか */
  const graph = useMemo(
    () => checkGraph(data.checkpoints.features as CheckpointFeature[], data.links),
    [data.checkpoints.features, data.links],
  );

  const linkLength = (l: LinkProps) => {
    const a = cpById.get(l.from)?.geometry.coordinates;
    const b = cpById.get(l.to)?.geometry.coordinates;
    return a && b ? metersBetween(a, b) : 0;
  };

  /* ---------------- 部屋（建物の中身） ---------------- */

  /** 選択中の建物にある部屋。階の低い順に並べる */
  const roomsOfSelected = useMemo(() => {
    if (!selectedFeature) return [];
    return data.rooms
      .filter((r) => r.buildingId === selectedFeature.properties.tempId)
      .sort((a, b) => a.floor - b.floor || a.code.localeCompare(b.code, "ja"));
  }, [data.rooms, selectedFeature]);

  /** 建物ごとの部屋数。一覧に出す */
  const roomCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data.rooms) m.set(r.buildingId, (m.get(r.buildingId) ?? 0) + 1);
    return m;
  }, [data.rooms]);

  const addRooms = (buildingId: string, codes: string[]) => {
    const cleaned = codes.map((c) => c.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    setData((prev) => {
      const rooms = [...prev.rooms];
      for (const code of cleaned) {
        // 同じ建物に同じ番号があれば飛ばす
        if (rooms.some((r) => r.buildingId === buildingId && r.code === code)) continue;
        rooms.push({
          id: nextRoomId(rooms),
          buildingId,
          code,
          name: "",
          floor: guessFloor(code),
          category: "class",
          hint: "",
        });
      }
      return { ...prev, rooms };
    });
  };

  const updateRoom = (id: string, patch: Partial<Room>) => {
    setData((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  };

  const removeRoom = (id: string) => {
    setData((prev) => ({ ...prev, rooms: prev.rooms.filter((r) => r.id !== id) }));
  };

  /* ---------------- チェックポイントの階層 ---------------- */

  const allCps = data.checkpoints.features as CheckpointFeature[];

  /** 選択中のCPの直下の子 */
  const childrenOfSelected = useMemo(
    () => (selectedCp ? childrenOf(allCps, selectedCp.properties.id) : []),
    [allCps, selectedCp],
  );

  /** 親を持たない level 2以上のCP。どこからも入れない */
  const orphans = useMemo(() => orphanCheckpoints(allCps), [allCps]);

  /** 親を1つ足す。既にあれば何もしない */
  const addParent = (childId: string, parentId: string) => {
    if (!parentId || childId === parentId) return;
    setData((prev) => ({
      ...prev,
      checkpoints: {
        type: "FeatureCollection",
        features: prev.checkpoints.features.map((f) => {
          if (f.properties.id !== childId) return f;
          if (f.properties.parents.includes(parentId)) return f;
          const parent = prev.checkpoints.features.find(
            (p) => p.properties.id === parentId,
          );
          return {
            ...f,
            properties: {
              ...f.properties,
              parents: [...f.properties.parents, parentId],
              // 親が増えたら、いちばん浅い親の1つ下に合わせる
              level: Math.max(2, (parent?.properties.level ?? 1) + 1),
            },
          };
        }),
      },
    }));
  };

  const removeParent = (childId: string, parentId: string) => {
    setData((prev) => ({
      ...prev,
      checkpoints: {
        type: "FeatureCollection",
        features: prev.checkpoints.features.map((f) =>
          f.properties.id === childId
            ? {
                ...f,
                properties: {
                  ...f.properties,
                  parents: f.properties.parents.filter((p) => p !== parentId),
                },
              }
            : f,
        ),
      },
    }));
  };

  /** 到着判定のチェックポイントが1つも紐づいていない場所 */
  const noEntrance = useMemo(() => {
    const linked = new Set(
      (data.checkpoints.features as CheckpointFeature[])
        .filter((f) => f.properties.linkedTo)
        .map((f) => f.properties.linkedTo),
    );
    return (data.buildings.features as BuildingFeature[]).filter(
      (f) => !linked.has(f.properties.tempId),
    );
  }, [data.buildings.features, data.checkpoints.features]);

  /**
   * 通路が届いていない場所。
   * ここに残っていると「その場所への行き方」が案内できない。
   */
  const unreachable = useMemo(() => {
    if (data.paths.features.length === 0) return [];
    const paths = data.paths.features as PathFeature[];
    return (data.buildings.features as BuildingFeature[])
      .map((f) => ({ f, d: distanceToPaths(f.geometry.coordinates[0], paths) }))
      .filter((x) => x.d > REACH_METERS);
  }, [data.buildings.features, data.paths.features]);

  /** 通路の総延長（メートル） */
  const pathTotal = useMemo(
    () =>
      data.paths.features.reduce((sum, f) => sum + lineLength(f.geometry.coordinates), 0),
    [data.paths.features],
  );

  const updatePath = (id: string, patch: Partial<PathProps>) => {
    setData((prev) => ({
      ...prev,
      paths: {
        type: "FeatureCollection",
        features: prev.paths.features.map((f) =>
          f.properties.id === id ? { ...f, properties: { ...f.properties, ...patch } } : f,
        ),
      },
    }));
  };

  const removePath = (id: string) => {
    setData((prev) => ({
      ...prev,
      paths: {
        type: "FeatureCollection",
        features: prev.paths.features.filter((f) => f.properties.id !== id),
      },
    }));
    setSelected(null);
  };

  const named = data.buildings.features.filter((f) => isNamed(f.properties)).length;

  /**
   * 今どの段階にいるかを判定して、次の一手だけを画面に出す。
   * ボタンが多く前後関係が見えないと迷うため、案内は常に1つに絞る。
   */
  const guide = useMemo(() => {
    if (mode === "link") {
      return {
        step: 5,
        title: linkFrom
          ? `${linkFrom} からつなぐ相手を押す`
          : "起点にするチェックポイントを押す",
        hint: "2つ押すとその区間が通れるようになります。続けて押していくと数珠つなぎに引けます。つないでいない区間は通れません。終えるなら Esc。",
      };
    }
    if (mode === "child") {
      return {
        step: 4,
        title: `${childParent} の先の場所を置く`,
        hint: "地図をクリックすると、その場所へは必ず親を通ってから入る扱いになります。別の入口からも入れる場合は、置いたあと「入口を追加」で親を足してください。終えるなら Esc。",
      };
    }
    if (mode === "checkpoint") {
      return {
        step: 4,
        title: "曲がり角と出入口にチェックポイントを置く",
        hint: "クリックするたびに1つ置かれます。経路はCPを結んだ線の上だけを通るので、曲がり角にも置いてください。終えるなら Esc。",
      };
    }
    if (mode === "path") {
      return {
        step: 4,
        title: "道なりにクリックして通路を引く",
        hint: `曲がり角ごとにクリック。2点で [確定] できます。既存の線の端点や頂点の${SNAP_METERS}m以内をクリックすると自動で吸着し、交差点がつながります。${snapCount > 0 ? `（今 ${snapCount} 回吸着）` : ""} やめるなら Esc。`,
      };
    }
    if (mode !== "none") {
      return {
        step: 1,
        title: `地図をクリックして${MODE_LABEL[mode]}の角を打つ`,
        hint: "角のたびにクリック。3点以上打つと [確定] が押せます。最後の点と最初の点は自動でつながります。やめるなら Esc。",
      };
    }
    if (data.campus.features.length === 0) {
      return {
        step: 1,
        title: "[敷地を描く] でキャンパスの範囲を囲む",
        hint: "この範囲を型にして、建物データから大学の分だけを切り抜きます。多少ざっくりで構いません。",
      };
    }
    if (data.buildings.features.length === 0) {
      return {
        step: 2,
        title: "[XMLを選ぶ] で建物を取り込む",
        hint: "raw フォルダの BldA が付いたファイルを選びます。グラウンドや駐輪場はこのデータに入っていないので [場所を描く] で足してください。",
      };
    }
    if (named < data.buildings.features.length) {
      return {
        step: 3,
        title: "地図上の場所をクリックして種別と名前を入れる",
        hint: `残り ${data.buildings.features.length - named} 件。まず種別（号館 / 施設 / 屋外 / その他）を選んでから名前を入れます。グラウンドや自転車小屋は「屋外」です。`,
      };
    }
    if (data.checkpoints.features.length < 2) {
      return {
        step: 4,
        title: "[CPを置く] で曲がり角と出入口に点を置く",
        hint: "経路はチェックポイントを結んだ線の上だけを通ります。まず交差点・曲がり角・各建物の出入口に置いてください。",
      };
    }
    if (data.links.length === 0) {
      return {
        step: 5,
        title: "[CP同士をつなぐ] で通れる区間を決める",
        hint: "チェックポイントを2つ押すと、その間が通れるようになります。つないでいない区間は通れません。",
      };
    }
    if (graph.unreachable.length > 0 || graph.isolated.length > 0) {
      return {
        step: 5,
        title: `経路が ${graph.groups} つに分断されています`,
        hint: `切り離されているCP：${[...graph.isolated, ...graph.unreachable].slice(0, 6).join(" / ")}。ここへは案内できません。本体とつないでください。`,
      };
    }
    if (orphans.length > 0) {
      return {
        step: 5,
        title: `入口が設定されていないCPが ${orphans.length} 件あります`,
        hint: `${orphans.map((o) => o.properties.id).slice(0, 6).join(" / ")}。レベル2以上なのに親が無いため、どこからも入れません。CPを選んで「入口を追加」してください。`,
      };
    }
    if (noEntrance.length > 0) {
      return {
        step: 5,
        title: `到着判定がない場所が ${noEntrance.length} 件あります`,
        hint: "出入口のCPを選び、「到着とみなす場所」でその建物を指定してください。半径の中に入ったら到着と判定されます。",
      };
    }
    return {
      step: 6,
      title: "ファイルを書き出す",
      hint: "campus / buildings / checkpoints / links を書き出して web/public/data/ に置けば完了です。区切りごとに書き出してください。",
    };
  }, [
    mode,
    snapCount,
    linkFrom,
    childParent,
    orphans,
    data.campus.features.length,
    data.buildings.features.length,
    data.checkpoints.features.length,
    data.links.length,
    graph,
    noEntrance.length,
    named,
  ]);

  /* ---------------- 描画 ---------------- */

  return (
    /* 高さは 100dvh で直接指定する。
       h-full（height:100%）は html→body→main→… の全てが 100% でないと連鎖が切れ、
       地図の描画面が潰れる（実際に canvas が 300px になる不具合が起きた）。 */
    <div className="relative w-full" style={{ height: "100dvh" }}>
      {/* 地図の置き場所。Tailwind の absolute inset-0 では高さが 0 になったため、
          クラスに頼らずインラインで指定する。ここが潰れると地図が丸ごと消える。 */}
      <div
        ref={containerRef}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      />

      {/* 地図が起動できなかった場合。真っ白のまま放置しない */}
      {fatal && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-100 p-8">
          <div className="max-w-lg rounded-lg bg-white p-5 shadow-xl ring-1 ring-red-300">
            <h2 className="text-sm font-bold text-red-700">地図を表示できません</h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-800">{fatal}</p>
            <p className="mt-3 border-t border-slate-200 pt-3 text-[11px] leading-relaxed text-slate-600">
              確認方法：ブラウザで <code className="rounded bg-slate-100 px-1">about:gpu</code>{" "}
              （Chrome / Edge）を開き、WebGL の項目が有効か確認してください。
              このメッセージをそのまま共有していただければ対応します。
            </p>
          </div>
        </div>
      )}

      {/* ベースマップ切替 */}
      <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-lg bg-white/95 p-1 shadow-lg ring-1 ring-slate-300">
        {BASE_ORDER.map((id) => (
          <button
            key={id}
            onClick={() => setBase(id)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition ${
              base === id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {BASES[id].label}
          </button>
        ))}
        {/* 航空写真は情報量が多く通路が埋もれる。暗くすると線だけが浮き上がる */}
        <button
          onClick={() => setDim((v) => !v)}
          title="背景を暗くして通路を見やすくする"
          className={`ml-1 rounded px-3 py-1.5 text-xs font-medium transition ${
            dim ? "bg-amber-500 text-white" : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          {dim ? "背景を戻す" : "背景を暗く"}
        </button>

        {/* 地図の向き。傾いた建物をなぞるとき、正対させると角が打ちやすい */}
        <span className="mx-1 inline-block h-4 w-px align-middle bg-slate-300" />
        <button
          onClick={() => rotateBy(-15)}
          title="反時計回りに15度"
          className="rounded px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          ↺
        </button>
        <button
          onClick={() => rotateBy(15)}
          title="時計回りに15度"
          className="rounded px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          ↻
        </button>
        <button
          onClick={resetNorth}
          title="北を上に戻す"
          className={`rounded px-2 py-1.5 text-xs font-medium transition ${
            Math.round(bearing) !== 0
              ? "bg-slate-900 text-white"
              : "text-slate-400 hover:bg-slate-100"
          }`}
        >
          北{Math.round(bearing) !== 0 && ` (${Math.round(bearing)}°)`}
        </button>

        {/* ラベルは密になると重なって作業の邪魔になるので個別に消せるようにする */}
        <span className="mx-1 inline-block h-4 w-px align-middle bg-slate-300" />
        <button
          onClick={() => setShowBuildingLabels((v) => !v)}
          title="建物名の表示を切り替える"
          className={`rounded px-2.5 py-1.5 text-xs font-medium transition ${
            showBuildingLabels
              ? "bg-slate-900 text-white"
              : "text-slate-400 line-through hover:bg-slate-100"
          }`}
        >
          建物名
        </button>
        <button
          onClick={() => setShowCpLabels((v) => !v)}
          title="チェックポイント名の表示を切り替える"
          className={`rounded px-2.5 py-1.5 text-xs font-medium transition ${
            showCpLabels
              ? "bg-green-600 text-white"
              : "text-slate-400 line-through hover:bg-slate-100"
          }`}
        >
          CP名
        </button>
      </div>

      {/* CPと接続を地図の上に直接描く。MapLibre のレイヤに依存しない */}
      {overlay && (
        <svg
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 5 }}
          width="100%"
          height="100%"
        >
          {/* 親子関係。通らないと入れない道すじ */}
          {overlay.hier.map(({ a, b, key }) => (
            <line
              key={key}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="#7c3aed"
              strokeWidth={2.5}
              strokeDasharray="4 3"
            />
          ))}

          {/* 接続。案内が通る区間。濃紺の縁取りを下に敷いて写真の上でも見えるようにする */}
          {overlay.lines.map(({ l, a, b }) => {
            const k = pathKindOf(l.kind);
            const w = k.width + 2.5;
            return (
              <g key={l.id}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#0f172a"
                  strokeWidth={w + 4}
                  strokeLinecap="round"
                  opacity={0.9}
                />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={
                    l.id === selected ? "#f97316" : !l.enabled ? "#94a3b8" : k.color
                  }
                  strokeWidth={w}
                  strokeLinecap="round"
                  strokeDasharray={l.enabled ? undefined : "6 4"}
                />
              </g>
            );
          })}

          {/* チェックポイント */}
          {overlay.cps.map((c) => {
            const p = overlay.pos.get(c.properties.id);
            if (!p) return null;
            const k = checkpointKindOf(c.properties.kind);
            const on = c.properties.id === selected || c.properties.id === linkFrom;
            return (
              <circle
                key={c.properties.id}
                cx={p.x}
                cy={p.y}
                r={on ? 9 : c.properties.level === 1 ? 6 : 4.5}
                fill={on ? "#ea580c" : k.color}
                stroke={on ? "#ea580c" : c.properties.level === 1 ? "#ffffff" : "#7c3aed"}
                strokeWidth={2.5}
              />
            );
          })}
        </svg>
      )}

      {/* 作図の進み具合。地図を見たまま数で確認できるようにする */}
      <div className="absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-full bg-slate-900/90 px-3 py-1.5 text-[11px] font-bold text-white shadow-lg">
        場所 {data.buildings.features.length}
        <span className="mx-1.5 opacity-40">|</span>
        CP {data.checkpoints.features.length}
        <span className="mx-1.5 opacity-40">|</span>
        <span className={data.links.length > 0 ? "text-sky-300" : "text-slate-400"}>
          接続 {data.links.length}
        </span>
        {data.links.length > 0 && (
          <>
            <span className="mx-1.5 opacity-40">|</span>
            {graph.unreachable.length + graph.isolated.length > 0 ? (
              <span className="text-red-300">
                未接続 {graph.unreachable.length + graph.isolated.length}
              </span>
            ) : (
              <span className="text-emerald-300">全部つながっています</span>
            )}
          </>
        )}
      </div>

      {/* 凡例。地図の色が何を表すか、地図を見たまま分かるようにする */}
      <div className="absolute bottom-8 right-3 z-10 rounded-lg bg-white/95 px-2.5 py-2 shadow-lg ring-1 ring-slate-300">
        <div className="mb-1 text-[10px] font-bold text-slate-900">種別</div>
        <ul className="space-y-0.5">
          {CATEGORIES.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5 text-[10px] text-slate-700">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm border"
                style={{ backgroundColor: c.color, borderColor: c.lineColor }}
              />
              {c.label}
            </li>
          ))}
          <li className="flex items-center gap-1.5 border-t border-slate-200 pt-0.5 text-[10px] text-slate-700">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-orange-500" />
            選択中
          </li>
        </ul>
      </div>

      {/* 作図パネル */}
      <div className="absolute bottom-8 left-3 top-3 z-10 flex w-80 flex-col gap-3 overflow-y-auto rounded-lg bg-white/95 p-3 shadow-xl ring-1 ring-slate-300">
        <div>
          <h1 className="text-sm font-bold text-slate-900">KIT MAP — 作図ツール</h1>

          {/* 今やることを1つだけ大きく出す。手順の前後関係が画面から読み取れないと迷うため */}
          <div className="mt-2 rounded-md bg-slate-900 p-2.5 text-slate-100">
            <div className="text-[10px] font-bold text-amber-300">
              次にやること（{guide.step} / 6）
            </div>
            <div className="mt-1 text-xs font-bold leading-snug">{guide.title}</div>
            <div className="mt-1 text-[10px] leading-relaxed text-slate-300">{guide.hint}</div>
            {selectedFeature && (
              <button
                onClick={() => setSelected(null)}
                className="mt-1.5 text-[10px] text-slate-400 underline hover:text-slate-200"
              >
                選択を解除
              </button>
            )}
          </div>
        </div>

        {/* 作図ボタン */}
        <div className="flex flex-col gap-2 rounded-md bg-slate-50 p-2 ring-1 ring-slate-200">
          {mode === "none" ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode("campus")}
                className="rounded bg-emerald-600 px-2 py-2 text-xs font-bold text-white hover:bg-emerald-700"
              >
                敷地を描く
              </button>
              <button
                onClick={() => setMode("building")}
                className="rounded bg-blue-600 px-2 py-2 text-xs font-bold text-white hover:bg-blue-700"
                title="建物のほか、グラウンドや自転車小屋なども描けます"
              >
                場所を描く
              </button>
              <button
                onClick={() => {
                  setSnapCount(0);
                  setMode("path");
                }}
                className="rounded bg-amber-500 px-2 py-2 text-xs font-bold text-white hover:bg-amber-600"
                title="経路探索が通る道。交差点では既存の線に自動で吸着します"
              >
                通路を描く
              </button>
              <button
                onClick={() => setMode("checkpoint")}
                className="rounded bg-green-600 px-2 py-2 text-xs font-bold text-white hover:bg-green-700"
                title="出入口など。ここに入ったら到着と判定します"
              >
                CPを置く
              </button>
              {/* 編集パネルの奥に隠れると見つからないので、ここにも出す */}
              <button
                onClick={() => {
                  if (!selectedCp) return;
                  setChildParent(selectedCp.properties.id);
                  setMode("child");
                }}
                disabled={!selectedCp}
                className="col-span-2 rounded bg-violet-600 px-2 py-2 text-xs font-bold text-white hover:bg-violet-700 disabled:bg-slate-400"
                title="選んだCPを通らないと入れない場所を置きます"
              >
                {selectedCp
                  ? `${selectedCp.properties.id} の先の場所を置く（レベル ${selectedCp.properties.level + 1}）`
                  : "先の場所を置く ← 先にCPを選んでください"}
              </button>
              <button
                onClick={() => {
                  setLinkFrom(null);
                  setMode("link");
                }}
                disabled={data.checkpoints.features.length < 2}
                className="col-span-2 rounded bg-sky-600 px-2 py-2 text-xs font-bold text-white hover:bg-sky-700 disabled:bg-slate-400"
                title="チェックポイントを2つ押すと、その間が通れるようになります"
              >
                {data.checkpoints.features.length < 2
                  ? "CPを2つ以上置いてください"
                  : "CP同士をつなぐ"}
              </button>
            </div>
          ) : (
            <>
              <div className="text-xs font-bold text-slate-900">
                {mode === "checkpoint"
                  ? "チェックポイントを設置中"
                  : mode === "child"
                    ? `${childParent} の先の場所を設置中`
                    : mode === "link"
                      ? "接続中"
                      : `${MODE_LABEL[mode]}を作図中 — 頂点 ${draft.length}`}
              </div>
              {mode === "link" ? (
                <>
                  <p className="text-[10px] leading-relaxed text-slate-600">
                    {linkFrom ? (
                      <>
                        <b className="text-sky-700">{linkFrom}</b> を選択中。
                        つなぎたい相手のチェックポイントを押してください。
                        続けて押していくと数珠つなぎに引けます。
                      </>
                    ) : (
                      <>起点にするチェックポイントを押してください。</>
                    )}
                  </p>
                  <div className="flex gap-1.5">
                    {linkFrom && (
                      <button
                        onClick={() => setLinkFrom(null)}
                        className="flex-1 rounded bg-slate-200 px-2 py-1.5 text-xs font-medium text-slate-800"
                      >
                        起点を解除
                      </button>
                    )}
                    <button
                      onClick={cancel}
                      className="flex-1 rounded bg-slate-900 px-2 py-1.5 text-xs font-bold text-white"
                    >
                      接続を終える (Esc)
                    </button>
                  </div>
                </>
              ) : mode === "child" ? (
                <>
                  <p className="rounded bg-violet-100 p-1.5 text-[10px] leading-relaxed text-violet-900">
                    <b>{childParent}</b> の先の場所を置きます。
                    地図をクリックするたびに1つ置かれ、
                    <b>{childParent} を通らないと入れない</b>場所になります。
                    続けてクリックすれば複数置けます。
                  </p>
                  <button
                    onClick={cancel}
                    className="rounded bg-slate-900 px-2 py-1.5 text-xs font-bold text-white"
                  >
                    設置を終える (Esc)
                  </button>
                </>
              ) : mode === "checkpoint" ? (
                <>
                  <p className="text-[10px] leading-relaxed text-slate-600">
                    地図をクリックするたびに1つ置かれます。これは<b>外から入れる点（レベル1）</b>です。
                    建物の中など「ここを通らないと入れない場所」は、置いたあと
                    <b>[この先の場所を置く]</b> で追加します。
                  </p>
                  <button
                    onClick={cancel}
                    className="rounded bg-slate-900 px-2 py-1.5 text-xs font-bold text-white"
                  >
                    設置を終える (Esc)
                  </button>
                </>
              ) : (
              <div className="flex gap-1.5">
                <button
                  onClick={finish}
                  disabled={draft.length < (mode === "path" ? 2 : 3)}
                  className="flex-1 rounded bg-slate-900 px-2 py-1.5 text-xs font-bold text-white disabled:bg-slate-300"
                >
                  確定 (Enter)
                </button>
                <button
                  onClick={undoPoint}
                  disabled={!draft.length}
                  className="rounded bg-slate-200 px-2 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-40"
                >
                  1つ戻す
                </button>
                <button
                  onClick={cancel}
                  className="rounded bg-slate-200 px-2 py-1.5 text-xs font-medium text-slate-800"
                >
                  取消 (Esc)
                </button>
              </div>
              )}
            </>
          )}
        </div>

        {/* タブ。建物一覧で埋まってCPが見えなくなるのを防ぐ */}
        <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-200 p-1">
          {(
            [
              ["places", "場所", data.buildings.features.length],
              ["route", "CP・経路", data.checkpoints.features.length],
              ["io", "入出力", null],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded px-1 py-1.5 text-[11px] font-bold transition ${
                tab === id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {label}
              {count !== null && (
                <span className="ml-1 font-normal text-slate-500">{count}</span>
              )}
            </button>
          ))}
        </div>

        {/* 基盤地図情報の取り込み */}
        <section
          className={`rounded-md bg-indigo-50 p-2 ring-1 ring-indigo-200 ${tab === "io" ? "" : "hidden"}`}
        >
          <h2 className="text-xs font-bold text-slate-900">基盤地図情報から取り込む</h2>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
            国土地理院の建築物データ（XML）を読み込み、
            <b>敷地の内側にある建物だけ</b>を自動で取り込みます。手描きが不要になります。
          </p>
          <label
            className={`mt-1.5 block rounded px-2 py-1.5 text-center text-[11px] font-bold text-white ${
              data.campus.features.length === 0 || busy
                ? "cursor-not-allowed bg-slate-400"
                : "cursor-pointer bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {busy
              ? "読み込み中…"
              : data.campus.features.length === 0
                ? "先に敷地を描いてください"
                : "XMLを選ぶ（複数可）"}
            <input
              type="file"
              accept=".xml"
              multiple
              disabled={data.campus.features.length === 0 || busy}
              className="hidden"
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                if (fs.length) void importFgd(fs);
                e.target.value = "";
              }}
            />
          </label>

          {/* 地図が出ない環境でも取り込みに進めるようにする */}
          {data.campus.features.length === 0 && (
            <button
              onClick={addRoughCampus}
              className="mt-1.5 w-full rounded border border-indigo-400 px-2 py-1.5 text-[11px] font-bold text-indigo-800 hover:bg-indigo-100"
            >
              仮の敷地を自動で作る（矩形）
            </button>
          )}
        </section>

        {/* 通知 */}
        {notice && (
          <div
            className={`rounded-md p-2 text-[11px] leading-relaxed ring-1 ${
              notice.kind === "ok"
                ? "bg-emerald-50 text-emerald-900 ring-emerald-300"
                : "bg-amber-50 text-amber-900 ring-amber-300"
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="flex-1">{notice.text}</span>
              <button
                onClick={() => setNotice(null)}
                className="shrink-0 font-bold opacity-60 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* 敷地 */}
        <section className={tab === "places" ? "" : "hidden"}>
          <h2 className="mb-1 text-xs font-bold text-slate-900">
            敷地（{data.campus.features.length}）
          </h2>
          {data.campus.features.length === 0 ? (
            <p className="text-[11px] text-slate-500">未作成</p>
          ) : (
            <ul className="space-y-1">
              {data.campus.features.map((f, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded bg-emerald-50 px-2 py-1 text-[11px] ring-1 ring-emerald-200"
                >
                  <span className="text-slate-800">
                    {f.properties.name}（{f.geometry.coordinates[0].length - 1}頂点）
                  </span>
                  <button
                    onClick={() => removeCampus(i)}
                    className="text-red-600 hover:underline"
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 建物 */}
        <section className={`flex-1 ${tab === "places" ? "" : "hidden"}`}>
          <h2 className="mb-1 text-xs font-bold text-slate-900">
            場所（{data.buildings.features.length}）
            <span className="ml-1 font-normal text-slate-500">名称 入力済 {named}</span>
          </h2>
          {/* 色の意味が分からないと地図が読めないので凡例を出す */}
          <div className="mb-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
            {CATEGORIES.map((c) => (
              <span key={c.id} className="text-[10px] text-slate-600">
                <span
                  className="mr-0.5 inline-block h-2 w-2 rounded-full border align-middle"
                  style={{ backgroundColor: c.color, borderColor: c.lineColor }}
                />
                {c.label}
              </span>
            ))}
          </div>
          {data.buildings.features.length === 0 ? (
            <p className="text-[11px] text-slate-500">未作成</p>
          ) : (
            <>
              {/* 範囲違いのデータを取り込んでしまったときに、1件ずつ消さずに済むようにする */}
              <button
                onClick={clearBuildings}
                className="mb-1.5 w-full rounded border border-red-300 px-2 py-1 text-[10px] font-bold text-red-700 hover:bg-red-50"
              >
                場所 {data.buildings.features.length} 件をすべて削除
              </button>
              <ul className="space-y-1">
                {(data.buildings.features as BuildingFeature[]).map((f) => (
                  <li key={f.properties.tempId}>
                    <button
                      onClick={() => flyTo(f)}
                      className={`w-full rounded px-2 py-1 text-left text-[11px] ring-1 transition ${
                        selected === f.properties.tempId
                          ? "bg-orange-100 ring-orange-400"
                          : "bg-slate-50 ring-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      <span
                        className="mr-1.5 inline-block h-2 w-2 rounded-full border align-middle"
                        style={{
                          backgroundColor: categoryOf(f.properties.category).color,
                          borderColor: categoryOf(f.properties.category).lineColor,
                        }}
                        title={categoryOf(f.properties.category).label}
                      />
                      <span className="font-mono text-slate-500">{f.properties.tempId}</span>
                      <span className="ml-2 font-bold text-slate-900">
                        {isNamed(f.properties) ? buildingLabel(f.properties) : "（名称未入力）"}
                      </span>
                      {(roomCount.get(f.properties.tempId) ?? 0) > 0 && (
                        <span className="ml-1 text-slate-500">
                          {roomCount.get(f.properties.tempId)}室
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* 通路（参考線） */}
        <section className={tab === "route" ? "" : "hidden"}>
          <h2 className="mb-1 text-xs font-bold text-slate-900">
            参考線（{data.paths.features.length}）
            <span className="ml-1 font-normal text-slate-500">
              計 {pathTotal >= 1000 ? `${(pathTotal / 1000).toFixed(2)}km` : `${Math.round(pathTotal)}m`}
              ／案内には使いません
            </span>
          </h2>

          {data.paths.features.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-slate-500">
              未作成。[通路を描く] は<b>下書き用</b>です。チェックポイントを置く位置の
              目安として道をなぞりたいときに使ってください。案内に使われるのは
              <b>接続</b>だけです。
            </p>
          ) : (
            <>
              {/* つながっていない端点は経路が大回りする原因になるので目立たせる */}
              {dangling.length > 0 ? (
                <div className="mb-1.5 rounded bg-red-50 p-1.5 text-[10px] leading-relaxed text-red-800 ring-1 ring-red-300">
                  <b>つながっていない端点が {dangling.length} 箇所</b>あります（地図上の赤い丸）。
                  交差点で他の線とつながっていないと、そこを曲がれず遠回りの経路になります。
                  端点の近く（{SNAP_METERS}m以内）をクリックすると自動で吸着します。
                </div>
              ) : (
                <div className="mb-1.5 rounded bg-emerald-50 p-1.5 text-[10px] text-emerald-800 ring-1 ring-emerald-300">
                  ✓ すべての端点がつながっています
                </div>
              )}

              {/* 通路が届いていない場所は、その場所への行き方を案内できない */}
              {unreachable.length > 0 && (
                <div className="mb-1.5 rounded bg-amber-50 p-1.5 text-[10px] leading-relaxed text-amber-900 ring-1 ring-amber-300">
                  <b>通路が届いていない場所が {unreachable.length} 件</b>あります
                  （{REACH_METERS}m以内に通路なし）。ここへの行き方は案内できません。
                  <ul className="mt-1 space-y-0.5">
                    {unreachable.slice(0, 8).map(({ f, d }) => (
                      <li key={f.properties.tempId}>
                        <button
                          onClick={() => flyTo(f)}
                          className="underline hover:no-underline"
                        >
                          {buildingLabel(f.properties)}
                        </button>
                        <span className="ml-1 opacity-70">
                          {Number.isFinite(d) ? `約${Math.round(d)}m` : "通路なし"}
                        </span>
                      </li>
                    ))}
                    {unreachable.length > 8 && <li>ほか {unreachable.length - 8} 件</li>}
                  </ul>
                </div>
              )}

              <ul className="space-y-1">
                {(data.paths.features as PathFeature[]).map((f) => {
                  const k = pathKindOf(f.properties.kind);
                  const len = lineLength(f.geometry.coordinates);
                  return (
                    <li key={f.properties.id}>
                      <button
                        onClick={() => setSelected(f.properties.id)}
                        className={`w-full rounded px-2 py-1 text-left text-[11px] ring-1 transition ${
                          selected === f.properties.id
                            ? "bg-orange-100 ring-orange-400"
                            : "bg-slate-50 ring-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        <span
                          className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ backgroundColor: k.color }}
                        />
                        <span className="font-mono text-slate-500">{f.properties.id}</span>
                        <span className="ml-2 text-slate-900">{k.label}</span>
                        <span className="ml-1 text-slate-500">{Math.round(len)}m</span>
                        {f.properties.roofed && <span className="ml-1">☂</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {/* 選択中の通路の編集 */}
        {selectedPath && (
          <section className="rounded-md bg-amber-50 p-2 ring-1 ring-amber-300">
            <h3 className="mb-2 text-xs font-bold text-slate-900">
              {selectedPath.properties.id} を編集
              <span className="ml-1 font-normal text-slate-600">
                {Math.round(lineLength(selectedPath.geometry.coordinates))}m ／
                {selectedPath.geometry.coordinates.length}点
              </span>
            </h3>
            <div className="space-y-1.5">
              <div className="text-[11px] text-slate-700">
                種別
                <div className="mt-0.5 grid grid-cols-2 gap-1">
                  {PATH_KINDS.map((k) => (
                    <button
                      key={k.id}
                      onClick={() => updatePath(selectedPath.properties.id, { kind: k.id })}
                      title={k.hint}
                      style={
                        selectedPath.properties.kind === k.id
                          ? { backgroundColor: k.color, borderColor: k.color, color: "#fff" }
                          : { borderColor: k.color, color: "#78350f" }
                      }
                      className="rounded border px-1 py-1 text-[10px] font-bold"
                    >
                      {k.label}
                      <span className="ml-1 font-normal opacity-80">×{k.weight}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                  {pathKindOf(selectedPath.properties.kind).hint}
                </p>
              </div>

              {/* 描いてはあるが案内には使わせたくない道を外すための切り替え */}
              <label className="flex items-center gap-1.5 rounded bg-white p-1.5 text-[11px] font-bold text-slate-800 ring-1 ring-slate-300">
                <input
                  type="checkbox"
                  checked={selectedPath.properties.enabled}
                  onChange={(e) =>
                    updatePath(selectedPath.properties.id, { enabled: e.target.checked })
                  }
                />
                道案内に使う
                {!selectedPath.properties.enabled && (
                  <span className="font-normal text-slate-500">（今は除外中）</span>
                )}
              </label>

              <label className="flex items-center gap-1.5 text-[11px] text-slate-700">
                <input
                  type="checkbox"
                  checked={selectedPath.properties.roofed}
                  onChange={(e) =>
                    updatePath(selectedPath.properties.id, { roofed: e.target.checked })
                  }
                />
                屋根がある（雨に濡れないルートに使う）
              </label>

              <label className="block text-[11px] text-slate-700">
                メモ
                <input
                  value={selectedPath.properties.note}
                  onChange={(e) =>
                    updatePath(selectedPath.properties.id, { note: e.target.value })
                  }
                  placeholder="夜間閉鎖 など"
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </label>

              <button
                onClick={() => removePath(selectedPath.properties.id)}
                className="w-full rounded bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700"
              >
                この通路を削除
              </button>
            </div>
          </section>
        )}

        {/* チェックポイント */}
        <section className={tab === "route" ? "" : "hidden"}>
          <h2 className="mb-1 text-xs font-bold text-slate-900">
            チェックポイント（{data.checkpoints.features.length}）
          </h2>

          {data.checkpoints.features.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-slate-500">
              未作成。[CPを置く] で出入口に点を打つと、そこに入ったときに
              「到着した」と判定できるようになります。
            </p>
          ) : (
            <>
              {noEntrance.length > 0 && (
                <div className="mb-1.5 rounded bg-amber-50 p-1.5 text-[10px] leading-relaxed text-amber-900 ring-1 ring-amber-300">
                  <b>到着判定がない場所が {noEntrance.length} 件</b>あります。
                  出入口にCPを置いて「到着とみなす場所」に紐づけてください。
                </div>
              )}
              {orphans.length > 0 && (
                <div className="mb-1.5 rounded bg-red-50 p-1.5 text-[10px] leading-relaxed text-red-800 ring-1 ring-red-300">
                  <b>入口が設定されていないCPが {orphans.length} 件</b>あります
                  （{orphans.map((o) => o.properties.id).slice(0, 6).join(" / ")}）。
                  レベル2以上なのに親が無いため、<b>どこからも入れません。</b>
                </div>
              )}
              <ul className="space-y-1">
                {(data.checkpoints.features as CheckpointFeature[]).map((f) => {
                  const k = checkpointKindOf(f.properties.kind);
                  const target = (data.buildings.features as BuildingFeature[]).find(
                    (b) => b.properties.tempId === f.properties.linkedTo,
                  );
                  return (
                    <li key={f.properties.id}>
                      <button
                        onClick={() => flyToCp(f)}
                        title="クリックすると地図がその位置へ移動します"
                        className={`w-full rounded px-2 py-1 text-left text-[11px] ring-1 transition ${
                          selected === f.properties.id
                            ? "bg-orange-100 ring-orange-400"
                            : "bg-slate-50 ring-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        <span
                          className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ backgroundColor: k.color }}
                        />
                        <span className="font-mono text-slate-500">{f.properties.id}</span>
                        {f.properties.level > 1 && (
                          <span className="ml-1 rounded bg-violet-100 px-1 text-[9px] font-bold text-violet-800">
                            Lv{f.properties.level}
                          </span>
                        )}
                        <span className="ml-1.5 text-slate-900">
                          {f.properties.name || k.label}
                        </span>
                        <span className="ml-1 text-slate-500">{f.properties.radius}m</span>
                        {target && (
                          <span className="ml-1 text-emerald-700">
                            → {buildingLabel(target.properties)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {/* 接続（経路グラフ） */}
        <section className={tab === "route" ? "" : "hidden"}>
          <h2 className="mb-1 text-xs font-bold text-slate-900">
            接続（{data.links.length}）
            <span className="ml-1 font-normal text-slate-500">
              案内はここだけを通ります
            </span>
          </h2>

          {data.links.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-slate-500">
              未作成。[CP同士をつなぐ] でチェックポイントを2つ押すと、その区間が通れるようになります。
              つないでいない区間は通れません。
            </p>
          ) : (
            <>
              {/* グラフが分断されていると、その先へは経路が出ない */}
              {graph.unreachable.length > 0 || graph.isolated.length > 0 ? (
                <div className="mb-1.5 rounded bg-red-50 p-1.5 text-[10px] leading-relaxed text-red-800 ring-1 ring-red-300">
                  <b>経路が {graph.groups} つに分断されています。</b>
                  {graph.isolated.length > 0 && (
                    <>
                      <br />
                      どこにもつながっていないCP：{graph.isolated.join(" / ")}
                    </>
                  )}
                  {graph.unreachable.length > 0 && (
                    <>
                      <br />
                      本体から切り離されているCP：{graph.unreachable.slice(0, 10).join(" / ")}
                      {graph.unreachable.length > 10 && ` ほか${graph.unreachable.length - 10}件`}
                    </>
                  )}
                  <br />
                  ここへは案内できません。つなぎ直してください。
                </div>
              ) : (
                <div className="mb-1.5 rounded bg-emerald-50 p-1.5 text-[10px] text-emerald-800 ring-1 ring-emerald-300">
                  ✓ すべてのチェックポイントがひと続きにつながっています
                </div>
              )}

              <ul className="space-y-1">
                {data.links.map((l) => {
                  const k = pathKindOf(l.kind);
                  const a = cpById.get(l.from);
                  const b = cpById.get(l.to);
                  return (
                    <li key={l.id}>
                      <button
                        onClick={() => setSelected(l.id)}
                        className={`w-full rounded px-2 py-1 text-left text-[11px] ring-1 transition ${
                          selected === l.id
                            ? "bg-orange-100 ring-orange-400"
                            : "bg-slate-50 ring-slate-200 hover:bg-slate-100"
                        } ${l.enabled ? "" : "opacity-50"}`}
                      >
                        <span
                          className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ backgroundColor: k.color }}
                        />
                        <span className="text-slate-900">
                          {a?.properties.name || l.from} → {b?.properties.name || l.to}
                        </span>
                        <span className="ml-1 text-slate-500">{Math.round(linkLength(l))}m</span>
                        {!l.enabled && <span className="ml-1 text-slate-500">（除外）</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {/* 選択中の接続の編集 */}
        {selectedLink && (
          <section className="rounded-md bg-sky-50 p-2 ring-1 ring-sky-300">
            <h3 className="mb-2 text-xs font-bold text-slate-900">
              {selectedLink.id} を編集
              <span className="ml-1 font-normal text-slate-600">
                {Math.round(linkLength(selectedLink))}m
              </span>
            </h3>
            <div className="space-y-1.5">
              <p className="text-[10px] text-slate-600">
                {cpById.get(selectedLink.from)?.properties.name || selectedLink.from}
                {" ↔ "}
                {cpById.get(selectedLink.to)?.properties.name || selectedLink.to}
              </p>

              <div className="text-[11px] text-slate-700">
                種別
                <div className="mt-0.5 grid grid-cols-2 gap-1">
                  {PATH_KINDS.map((k) => (
                    <button
                      key={k.id}
                      onClick={() => updateLink(selectedLink.id, { kind: k.id })}
                      title={k.hint}
                      style={
                        selectedLink.kind === k.id
                          ? { backgroundColor: k.color, borderColor: k.color, color: "#fff" }
                          : { borderColor: k.color, color: "#78350f" }
                      }
                      className="rounded border px-1 py-1 text-[10px] font-bold"
                    >
                      {k.label}
                      <span className="ml-1 font-normal opacity-80">×{k.weight}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-1.5 rounded bg-white p-1.5 text-[11px] font-bold text-slate-800 ring-1 ring-slate-300">
                <input
                  type="checkbox"
                  checked={selectedLink.enabled}
                  onChange={(e) => updateLink(selectedLink.id, { enabled: e.target.checked })}
                />
                道案内に使う
                {!selectedLink.enabled && (
                  <span className="font-normal text-slate-500">（今は除外中）</span>
                )}
              </label>

              <label className="flex items-center gap-1.5 text-[11px] text-slate-700">
                <input
                  type="checkbox"
                  checked={selectedLink.roofed}
                  onChange={(e) => updateLink(selectedLink.id, { roofed: e.target.checked })}
                />
                屋根がある
              </label>

              <label className="block text-[11px] text-slate-700">
                メモ
                <input
                  value={selectedLink.note}
                  onChange={(e) => updateLink(selectedLink.id, { note: e.target.value })}
                  placeholder="夜間閉鎖 など"
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </label>

              <button
                onClick={() => removeLink(selectedLink.id)}
                className="w-full rounded bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700"
              >
                この接続を削除
              </button>
            </div>
          </section>
        )}

        {/* 選択中のチェックポイントの編集 */}
        {selectedCp && (
          <section className="rounded-md bg-green-50 p-2 ring-1 ring-green-300">
            <h3 className="mb-1 text-xs font-bold text-slate-900">
              {selectedCp.properties.id} を編集
            </h3>
            {/* どこに置いたかを数値でも確かめられるようにする */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <code className="text-[10px] text-slate-600">
                {selectedCp.geometry.coordinates[1].toFixed(6)},{" "}
                {selectedCp.geometry.coordinates[0].toFixed(6)}
              </code>
              <button
                onClick={() => flyToCp(selectedCp)}
                className="shrink-0 rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-800 hover:bg-slate-300"
              >
                この位置へ移動
              </button>
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] text-slate-700">
                種類
                <div className="mt-0.5 grid grid-cols-3 gap-1">
                  {CHECKPOINT_KINDS.map((k) => (
                    <button
                      key={k.id}
                      onClick={() =>
                        updateCp(selectedCp.properties.id, { kind: k.id, radius: k.radius })
                      }
                      title={k.hint}
                      style={
                        selectedCp.properties.kind === k.id
                          ? { backgroundColor: k.color, borderColor: k.color, color: "#fff" }
                          : { borderColor: k.color, color: k.color }
                      }
                      className="rounded border px-1 py-1 text-[10px] font-bold"
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                  {checkpointKindOf(selectedCp.properties.kind).hint}
                </p>
              </div>

              <label className="block text-[11px] text-slate-700">
                名前
                <input
                  value={selectedCp.properties.name}
                  onChange={(e) => updateCp(selectedCp.properties.id, { name: e.target.value })}
                  placeholder="例: 23号館 南口"
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </label>

              <label className="block text-[11px] text-slate-700">
                到着とみなす場所
                <select
                  value={selectedCp.properties.linkedTo}
                  onChange={(e) =>
                    updateCp(selectedCp.properties.id, { linkedTo: e.target.value })
                  }
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                >
                  <option value="">（紐づけない）</option>
                  {(data.buildings.features as BuildingFeature[]).map((b) => (
                    <option key={b.properties.tempId} value={b.properties.tempId}>
                      {b.properties.tempId} {buildingLabel(b.properties)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[11px] text-slate-700">
                到着判定の半径：<b>{selectedCp.properties.radius}m</b>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={1}
                  value={selectedCp.properties.radius}
                  onChange={(e) =>
                    updateCp(selectedCp.properties.id, { radius: Number(e.target.value) })
                  }
                  className="mt-0.5 w-full"
                />
                <span className="text-[10px] text-slate-500">
                  GPSの誤差は屋外でも 5〜15m 出ます。狭すぎると到着と判定されません。
                </span>
              </label>

              {/* 階層。親を通らないと子に入れない構造を作る */}
              <div className="rounded bg-white p-2 ring-1 ring-slate-300">
                <h4 className="text-[11px] font-bold text-slate-900">
                  階層：レベル {selectedCp.properties.level}
                  {selectedCp.properties.level === 1 && (
                    <span className="ml-1 font-normal text-slate-600">外から入れる</span>
                  )}
                </h4>

                {/* 親。どれか1つを通れば入れる（OR） */}
                {selectedCp.properties.level >= 2 && (
                  <div className="mt-1.5">
                    <p className="text-[10px] text-slate-700">
                      ここに入るには、下のうち<b>どれか1つ</b>を通る必要があります
                    </p>
                    {selectedCp.properties.parents.length === 0 ? (
                      <p className="mt-0.5 rounded bg-red-50 p-1 text-[10px] font-bold text-red-800 ring-1 ring-red-300">
                        親が未設定です。このままではどこからも入れません。
                      </p>
                    ) : (
                      <ul className="mt-0.5 space-y-0.5">
                        {selectedCp.properties.parents.map((pid) => {
                          const p = cpById.get(pid);
                          return (
                            <li key={pid} className="flex items-center gap-1">
                              <button
                                onClick={() => p && flyToCp(p)}
                                className="min-w-0 flex-1 truncate rounded bg-slate-100 px-1.5 py-0.5 text-left text-[10px] hover:bg-slate-200"
                              >
                                <span className="font-mono text-slate-500">{pid}</span>
                                <span className="ml-1">{p?.properties.name || ""}</span>
                              </button>
                              <button
                                onClick={() => removeParent(selectedCp.properties.id, pid)}
                                title="この親を外す"
                                className="shrink-0 px-1 text-[11px] font-bold text-red-600 hover:text-red-800"
                              >
                                ×
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <select
                      value=""
                      onChange={(e) => addParent(selectedCp.properties.id, e.target.value)}
                      className="mt-1 w-full rounded border border-slate-300 px-1 py-0.5 text-[10px]"
                    >
                      <option value="">＋ 入口を追加（別の入口からも入れる場合）</option>
                      {allCps
                        .filter(
                          (c) =>
                            c.properties.id !== selectedCp.properties.id &&
                            !selectedCp.properties.parents.includes(c.properties.id) &&
                            c.properties.level < selectedCp.properties.level,
                        )
                        .map((c) => (
                          <option key={c.properties.id} value={c.properties.id}>
                            {c.properties.id} {c.properties.name || ""}（Lv{c.properties.level}）
                          </option>
                        ))}
                    </select>
                  </div>
                )}

                {/* 子。ここを通らないと入れない場所 */}
                <div className="mt-2">
                  <p className="text-[10px] text-slate-700">
                    この先の場所（{childrenOfSelected.length}）
                  </p>
                  {childrenOfSelected.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {childrenOfSelected.map((c) => (
                        <li key={c.properties.id}>
                          <button
                            onClick={() => flyToCp(c)}
                            className="w-full truncate rounded bg-violet-50 px-1.5 py-0.5 text-left text-[10px] ring-1 ring-violet-200 hover:bg-violet-100"
                          >
                            <span className="font-mono text-slate-500">{c.properties.id}</span>
                            <span className="ml-1">{c.properties.name || "（名称未入力）"}</span>
                            <span className="ml-1 text-slate-500">
                              Lv{c.properties.level}
                              {c.properties.parents.length > 1 &&
                                ` / 入口${c.properties.parents.length}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    onClick={() => {
                      setChildParent(selectedCp.properties.id);
                      setMode("child");
                    }}
                    className="mt-1 w-full rounded bg-violet-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-violet-700"
                  >
                    ＋ この先の場所を置く（レベル {selectedCp.properties.level + 1}）
                  </button>
                </div>
              </div>

              <button
                onClick={() => removeCp(selectedCp.properties.id)}
                className="w-full rounded bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700"
              >
                このCPを削除
              </button>
            </div>
          </section>
        )}

        {/* 選択中の建物の編集 */}
        {selectedFeature && (
          <section className="rounded-md bg-orange-50 p-2 ring-1 ring-orange-300">
            <h3 className="mb-2 text-xs font-bold text-slate-900">
              {selectedFeature.properties.tempId} を編集
            </h3>
            <div className="space-y-1.5">
              {/* 種別を最初に選ばせる。以降の入力欄はこれで切り替わる */}
              <div className="text-[11px] text-slate-700">
                種別
                <div className="mt-0.5 grid grid-cols-4 gap-1">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.id}
                      onClick={() =>
                        updateBuilding(selectedFeature.properties.tempId, {
                          category: c.id,
                          // 号館以外に変えたら番号は持ち越さない
                          ...(c.hasCode ? {} : { code: "" }),
                          ...(c.hasFloors ? {} : { floors: 0 }),
                        })
                      }
                      style={
                        selectedFeature.properties.category === c.id
                          ? {
                              backgroundColor: c.color,
                              borderColor: c.lineColor,
                              color: c.textColor,
                            }
                          : { borderColor: c.lineColor, color: c.lineColor }
                      }
                      className="rounded border px-1 py-1 text-[10px] font-bold"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              {categoryOf(selectedFeature.properties.category).hasCode && (
                <label className="block text-[11px] text-slate-700">
                  号館番号
                  <input
                    value={selectedFeature.properties.code}
                    onChange={(e) =>
                      updateBuilding(selectedFeature.properties.tempId, {
                        code: e.target.value,
                        name: e.target.value ? `${e.target.value}号館` : "",
                      })
                    }
                    placeholder="例: 23"
                    className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </label>
              )}

              <label className="block text-[11px] text-slate-700">
                名称
                <input
                  value={selectedFeature.properties.name}
                  onChange={(e) =>
                    updateBuilding(selectedFeature.properties.tempId, { name: e.target.value })
                  }
                  placeholder={`例: ${categoryOf(selectedFeature.properties.category).example}`}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </label>

              {categoryOf(selectedFeature.properties.category).hasFloors && (
                <label className="block text-[11px] text-slate-700">
                  階数（0 = 未確認）
                  <input
                    type="number"
                    min={0}
                    value={selectedFeature.properties.floors}
                    onChange={(e) =>
                      updateBuilding(selectedFeature.properties.tempId, {
                        floors: Number(e.target.value),
                      })
                    }
                    className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </label>
              )}
              <label className="block text-[11px] text-slate-700">
                メモ
                <input
                  value={selectedFeature.properties.note}
                  onChange={(e) =>
                    updateBuilding(selectedFeature.properties.tempId, { note: e.target.value })
                  }
                  placeholder="現地確認の気づきなど"
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </label>
              {/* 建物の中身。座標を持たないので表として入れる */}
              <div className="rounded bg-white p-2 ring-1 ring-slate-300">
                <h4 className="text-[11px] font-bold text-slate-900">
                  この建物の中（{roomsOfSelected.length}）
                </h4>
                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">
                  部屋番号を入れておくと、案内の最後に
                  「<b>302 は 3階です</b>」と出せます。地図上の位置は不要です。
                </p>

                {/* シラバスからコピーした一覧をそのまま流し込めるようにする */}
                <textarea
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder={"まとめて貼り付け（1行1部屋）\n302\n301\n201"}
                  rows={3}
                  className="mt-1.5 w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
                />
                <button
                  onClick={() => {
                    addRooms(selectedFeature.properties.tempId, roomInput.split(/[\n,、]/));
                    setRoomInput("");
                  }}
                  disabled={!roomInput.trim()}
                  className="mt-1 w-full rounded bg-slate-900 px-2 py-1 text-[11px] font-bold text-white disabled:bg-slate-300"
                >
                  追加する（階は番号から自動判定）
                </button>

                {roomsOfSelected.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {roomsOfSelected.map((r) => (
                      <li key={r.id} className="flex items-center gap-1">
                        <input
                          value={r.code}
                          onChange={(e) => updateRoom(r.id, { code: e.target.value })}
                          placeholder="302"
                          className="w-14 rounded border border-slate-300 px-1 py-0.5 text-[11px]"
                        />
                        <input
                          value={r.name}
                          onChange={(e) => updateRoom(r.id, { name: e.target.value })}
                          placeholder="名称（任意）"
                          className="min-w-0 flex-1 rounded border border-slate-300 px-1 py-0.5 text-[11px]"
                        />
                        <input
                          type="number"
                          value={r.floor}
                          onChange={(e) => updateRoom(r.id, { floor: Number(e.target.value) })}
                          title="階。地下は -1 のように負の数"
                          className="w-11 rounded border border-slate-300 px-1 py-0.5 text-[11px]"
                        />
                        <select
                          value={r.category}
                          onChange={(e) =>
                            updateRoom(r.id, { category: e.target.value as Room["category"] })
                          }
                          style={{ color: roomCategoryOf(r.category).color }}
                          className="rounded border border-slate-300 px-0.5 py-0.5 text-[10px] font-bold"
                        >
                          {ROOM_CATEGORIES.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => removeRoom(r.id)}
                          title="削除"
                          className="shrink-0 px-1 text-[11px] font-bold text-red-600 hover:text-red-800"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {roomsOfSelected.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    階の内訳：
                    {[...new Set(roomsOfSelected.map((r) => r.floor))]
                      .sort((a, b) => a - b)
                      .map(
                        (f) =>
                          `${floorLabel(f)} ${roomsOfSelected.filter((r) => r.floor === f).length}室`,
                      )
                      .join(" / ")}
                  </p>
                )}
              </div>

              <button
                onClick={() => removeBuilding(selectedFeature.properties.tempId)}
                className="w-full rounded bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700"
              >
                この建物を削除
              </button>
            </div>
          </section>
        )}

        {/* 入出力 */}
        <section
          className={`border-t border-slate-200 pt-2 ${tab === "io" ? "" : "hidden"}`}
        >
          <h2 className="mb-1.5 text-xs font-bold text-slate-900">書き出し / 読み込み</h2>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => downloadJson("campus.geojson", data.campus)}
              className="rounded bg-emerald-600 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-700"
            >
              campus.geojson
            </button>
            <button
              onClick={() => downloadJson("buildings.geojson", data.buildings)}
              className="rounded bg-blue-600 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700"
            >
              buildings.geojson
            </button>
            <button
              onClick={() => downloadJson("paths.geojson", data.paths)}
              className="rounded bg-amber-500 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-amber-600"
            >
              paths.geojson
            </button>
            <button
              onClick={() => downloadJson("checkpoints.geojson", data.checkpoints)}
              className="rounded bg-green-600 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-green-700"
            >
              checkpoints.geojson
            </button>
            <button
              onClick={() =>
                downloadJson("links.geojson", {
                  type: "FeatureCollection",
                  // 経路グラフの辺。線の形はCPの座標から作って書き出す
                  features: data.links.flatMap((l) => {
                    const a = cpById.get(l.from)?.geometry.coordinates;
                    const b = cpById.get(l.to)?.geometry.coordinates;
                    if (!a || !b) return [];
                    return [
                      {
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: [a, b] },
                        properties: { ...l, lengthM: Math.round(linkLength(l)) },
                      },
                    ];
                  }),
                })
              }
              className="col-span-2 rounded bg-sky-600 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-sky-700"
            >
              links.geojson（経路グラフ）
            </button>
            <button
              onClick={() => downloadJson("rooms.json", data.rooms)}
              disabled={data.rooms.length === 0}
              className="col-span-2 rounded bg-slate-700 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              rooms.json（部屋 {data.rooms.length}）
            </button>
          </div>
          <label className="mt-1.5 block cursor-pointer rounded bg-slate-200 px-2 py-1.5 text-center text-[11px] font-medium text-slate-800 hover:bg-slate-300">
            読み込み
            <input
              type="file"
              accept=".geojson,.json"
              multiple={false}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {/* 保存されている確証を出す。見えないと不安で作業できないため */}
          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
            {savedAt ? (
              <>
                <span className="font-bold text-emerald-700">
                  ✓ 自動保存済み {savedAt.toLocaleTimeString("ja-JP")}
                </span>
                <br />
                このブラウザを閉じても残ります。ただし
                <b>閲覧履歴の削除・シークレットウィンドウ・別ブラウザ</b>
                では消えるので、区切りごとに書き出して
                <code className="mx-0.5">public/data/</code>に置いてください。
              </>
            ) : (
              <>作図するとブラウザに自動保存されます。</>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}
