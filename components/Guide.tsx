"use client";

/**
 * KIT map — 案内画面。
 *
 * 地図のタイルだけ MapLibre に描かせ、建物・経路・現在地は
 * SVG を重ねて自前で描く。MapLibre のレイヤ経由の描画が
 * 反映されない問題があったため、確実に出る方式に寄せてある。
 *
 * 建物の名前は地図に出さない（画面が文字で埋まるため）。
 * 建物の判別は検索と、選択中のハイライトで行う。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MlMap, NavigationControl, ScaleControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Position } from "geojson";
import { BASES, GSI_ATTRIBUTION, INITIAL_VIEW } from "@/lib/gsi";
import { categoryOf, type CheckpointFeature } from "@/lib/features";
import { loadAppData, loadRooms, search, type AppData, type SearchHit } from "@/lib/appdata";
import { canViewCampusInfo, type Role } from "@/lib/auth";
import { buildGraph, buildSteps, findPath, nearestNode } from "@/lib/route";
import { metersBetween } from "@/lib/geo";

/** 精度の扱い。推測で決めず3段階に分ける */
const ACC_TRUST = 20;
const ACC_ROUGH = 50;
/** 現在地からこの距離以内に経路の節点が無ければ案内できない */
const SNAP_MAX = 50;

type Fix = { pos: Position; accuracy: number; at: number };
/** 出発地。現在地か、検索で選んだ場所 */
type Origin = { kind: "me" } | { kind: "place"; hit: SearchHit };

export default function Guide() {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  const [data, setData] = useState<AppData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const [fix, setFix] = useState<Fix | null>(null);
  const [geoState, setGeoState] = useState<
    "idle" | "asking" | "on" | "rough" | "denied" | "timeout" | "unavailable" | "insecure"
  >("idle");
  const watchId = useRef<number | null>(null);

  /** 起動時のタイトル画面。0.4秒かけて上下に割れる */
  const [splash, setSplash] = useState<"open" | "closing" | "done">("open");

  const closeSplash = useCallback(() => {
    setSplash((s) => {
      if (s !== "open") return s;
      window.setTimeout(() => setSplash("done"), 400);
      return "closing";
    });
  }, []);

  /** 少し見せてから自動で開く。触れば即座に開く */
  useEffect(() => {
    const t = window.setTimeout(closeSplash, 900);
    return () => clearTimeout(t);
  }, [closeSplash]);
  /** 左のサイドバーを開いているか */
  const [side, setSide] = useState(false);
  /** ログイン画面を開いているか */
  const [login, setLogin] = useState(false);
  /** 一覧から選んで注目している建物 */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** 建物一覧を開いているか */
  const [listOpen, setListOpen] = useState(false);
  /** 一覧をスワイプで開閉するための、指を置いた位置 */
  const touchY = useRef<number | null>(null);
  /** ログインしている人の権限。未ログインなら null */
  const [role, setRole] = useState<Role | null>(null);
  /** 経路検索のパネルを開いているか */
  const [panel, setPanel] = useState(false);
  const [origin, setOrigin] = useState<Origin>({ kind: "me" });
  const [dest, setDest] = useState<SearchHit | null>(null);
  /** 実際に案内中の組み合わせ。[スタート]を押して確定する */
  const [trip, setTrip] = useState<{ origin: Origin; dest: SearchHit } | null>(null);
  const [arrived, setArrived] = useState(false);
  const inRangeSince = useRef<number | null>(null);

  /* ---------------- 地図 ---------------- */

  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    boxRef.current.innerHTML = "";
    let map: MlMap;
    try {
      map = new MlMap({
        container: boxRef.current,
        center: INITIAL_VIEW.center,
        zoom: 17,
        maxZoom: 21,
        // 既定の出典表示は畳まれて「ⓘ」ボタンになる。
        // ボタンを消したいが出典表示は地理院タイルの利用条件で必須なので、
        // 自前で「畳まない」ものを付け直して、小さな文字として常時出す。
        attributionControl: false,
        style: {
          version: 8,
          sources: {
            photo: {
              type: "raster",
              tiles: [BASES.photo.url],
              tileSize: BASES.photo.tileSize,
              maxzoom: BASES.photo.maxzoom,
              attribution: GSI_ATTRIBUTION,
            },
          },
          layers: [{ id: "photo", type: "raster", source: "photo" }],
        },
      });
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      return;
    }

    // 下の建物一覧に隠れないよう、地図の操作系は右上寄りに置く。
    // 出典表示は MapLibre に任せず自前で出す（一覧に隠れると条件を満たせないため）
    map.addControl(new NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 90, unit: "metric" }), "top-right");

    const bump = () => setTick((v) => v + 1);
    for (const ev of ["move", "zoom", "rotate", "resize", "load"] as const) map.on(ev, bump);
    map.on("load", () => setReady(true));

    /**
     * 描画面の大きさを測り直す。
     *
     * iOS はアドレスバーの出入りで表示領域の高さが変わる。
     * URLを触って再読み込みしたときなど、地図を作った直後と
     * 実際の高さが食い違い、canvas が画面の半分のまま残ることがある。
     * 取りこぼしを無くすため、複数の合図で測り直す。
     */
    const fit = () => {
      map.resize();
      bump();
    };

    const ro = new ResizeObserver(fit);
    ro.observe(boxRef.current);
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    window.visualViewport?.addEventListener("resize", fit);
    // 初回描画のあとレイアウトが確定することがあるので、少し遅らせても測る
    const timers = [80, 300, 900].map((ms) => window.setTimeout(fit, ms));

    mapRef.current = map;
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      timers.forEach(clearTimeout);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /** 起動画面が消えたあとにも測り直す（隠れている間に高さが変わることがある） */
  useEffect(() => {
    if (splash !== "done") return;
    const t = window.setTimeout(() => {
      mapRef.current?.resize();
      setTick((v) => v + 1);
    }, 60);
    return () => clearTimeout(t);
  }, [splash]);

  useEffect(() => {
    void loadAppData().then(setData);
  }, []);

  /**
   * ログイン状態と教室。
   *
   * 教室（rooms）は承認された人だけが読める。
   * 未ログインでは RLS が空を返すので、検索候補にも出てこない。
   */
  useEffect(() => {
    void (async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!url) return;
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: u } = await supabase.auth.getUser();
        if (!u.user) return;

        const { data: p } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", u.user.id)
          .single();
        const r = (p?.role as Role) ?? null;
        setRole(r);
        if (!canViewCampusInfo(r)) return;

        const rooms = await loadRooms();
        setData((prev) => (prev ? { ...prev, rooms } : prev));
      } catch {
        // 未設定・未接続なら地図だけで動く
      }
    })();
  }, []);

  /* ---------------- 現在地 ---------------- */

  const startWatch = useCallback(() => {
    // 押した時点で描画面を測り直す。
    // 位置情報の許可ダイアログでアドレスバーの高さが変わることがあり、
    // ここで直しておかないと地図が半分のまま残る
    mapRef.current?.resize();
    setTick((v) => v + 1);

    // Safari / iOS で「使えない」原因のほとんどは HTTPS でないこと。
    // localhost だけは例外的に許される。
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setGeoState("insecure");
      return;
    }
    if (!navigator.geolocation) {
      setGeoState("denied");
      return;
    }
    if (watchId.current != null) {
      if (fix) mapRef.current?.easeTo({ center: [fix.pos[0], fix.pos[1]], zoom: 18 });
      return;
    }

    setGeoState("asking");

    const accept = (p: GeolocationPosition) => {
      const acc = p.coords.accuracy;
      const now = Date.now();
      const next: Fix = { pos: [p.coords.longitude, p.coords.latitude], accuracy: acc, at: now };
      setFix((prev) => {
        if (!prev) return next;
        // iOS/Android は最初に基地局やWi-Fiの粗い位置を返し、
        // 数秒〜十数秒かけて GPS の精度に上がっていく。
        // より精度の良いものだけ採用する。ただし古い値に居座られないよう、
        // 15秒経ったら無条件に入れ替える。
        const stale = now - prev.at > 15_000;
        return acc <= prev.accuracy || stale ? next : prev;
      });
      // 粗いあいだも位置は出す（円で誤差を正直に見せる）
      setGeoState(acc > ACC_ROUGH ? "rough" : "on");
    };

    const fail = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) setGeoState("denied");
      else if (err.code === err.TIMEOUT) setGeoState("timeout");
      else setGeoState("unavailable");
    };

    // ★ iOS Safari は enableHighAccuracy の watchPosition が
    //   一度も呼ばれないまま黙り込むことがある。
    //   まず精度を問わない一発取得で「とにかく位置を出す」。
    navigator.geolocation.getCurrentPosition(accept, () => {}, {
      enableHighAccuracy: false,
      maximumAge: 30_000,
      timeout: 10_000,
    });

    // そのうえで高精度の追従を始める
    watchId.current = navigator.geolocation.watchPosition(accept, fail, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 30_000,
    });

    // 15秒経っても何も返らなければ、高精度をあきらめて取り直す。
    // iOS で「押しても何も起きない」状態になるのを防ぐ
    window.setTimeout(() => {
      setFix((cur) => {
        if (cur) return cur;
        navigator.geolocation.getCurrentPosition(accept, fail, {
          enableHighAccuracy: false,
          maximumAge: 60_000,
          timeout: 20_000,
        });
        return cur;
      });
    }, 15_000);
  }, [fix]);

  useEffect(
    () => () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    },
    [],
  );

  /** 起動時はキャンパス全体が入るように合わせる */
  const fitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !data || fitted.current) return;
    const feats = data.buildings.features;
    if (feats.length === 0) return;
    fitted.current = true;
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    for (const f of feats) {
      for (const [lon, lat] of f.geometry.coordinates[0]) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 48, duration: 0 },
    );
  }, [ready, data]);

  /** 現在地が取れたら一度だけ寄せる */
  const centered = useRef(false);
  useEffect(() => {
    if (fix && !centered.current) {
      centered.current = true;
      mapRef.current?.easeTo({ center: [fix.pos[0], fix.pos[1]], zoom: 18 });
    }
  }, [fix]);

  /* ---------------- 圏内判定 ---------------- */

  const inCampus = useMemo(() => {
    if (!data || !fix) return null;
    const poly = data.campus.features[0]?.geometry.coordinates[0];
    if (!poly) return null;
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (
        yi > fix.pos[1] !== yj > fix.pos[1] &&
        fix.pos[0] < ((xj - xi) * (fix.pos[1] - yi)) / (yj - yi) + xi
      )
        ins = !ins;
    }
    return ins;
  }, [data, fix]);

  /* ---------------- 経路 ---------------- */

  const graph = useMemo(() => (data ? buildGraph(data) : null), [data]);

  /** 建物IDから、その場所の出入口CP一覧 */
  const entrancesOf = useCallback(
    (buildingId: string) =>
      ((data?.checkpoints.features ?? []) as CheckpointFeature[]).filter(
        (c) => c.properties.linkedTo === buildingId,
      ),
    [data],
  );

  const route = useMemo(() => {
    if (!data || !graph || !trip) return null;

    /* 起点 */
    let startId: string | null = null;
    let fromGate = false;
    if (trip.origin.kind === "me") {
      if (fix && inCampus !== false) startId = nearestNode(graph, fix.pos, SNAP_MAX)?.id ?? null;
      // 現在地がまだ取れていなくても案内は出す。門を起点にして、そう伝える
      if (!startId) {
        const gate = (data.checkpoints.features as CheckpointFeature[]).find(
          (c) => c.properties.kind === "gate",
        );
        startId = gate?.properties.id ?? null;
        fromGate = true;
      }
      if (!startId) return { error: "経路の起点が見つかりません" as const };
    } else {
      const ents = entrancesOf(trip.origin.hit.buildingId);
      if (ents.length === 0) return { error: "出発地の入口が登録されていません" as const };
      startId = ents[0].properties.id;
    }

    /* 目的地：紐づく出入口のうち起点からいちばん近いもの */
    const ents = entrancesOf(trip.dest.buildingId);
    if (ents.length === 0) return { error: "目的地の入口が登録されていません" as const };
    const startPos = graph.pos.get(startId)!;
    const goal = ents
      .map((e) => ({ e, d: metersBetween(startPos, e.geometry.coordinates) }))
      .sort((a, b) => a.d - b.d)[0].e;

    const path = findPath(graph, startId, goal.properties.id);
    if (!path) return { error: "経路が見つかりませんでした" as const };

    const { steps, meters, minutes } = buildSteps(graph, path, data, trip.dest.title);
    return { path, steps, meters, minutes, goal, startId, fromGate };
  }, [data, graph, trip, fix, inCampus, entrancesOf]);

  /* ---------------- 到着判定 ---------------- */

  useEffect(() => {
    if (!route || "error" in route || !fix || trip?.origin.kind !== "me") {
      inRangeSince.current = null;
      return;
    }
    const d = metersBetween(fix.pos, route.goal.geometry.coordinates);
    if (d <= route.goal.properties.radius) {
      // 一瞬の誤差で誤判定しないよう、3秒入り続けたら到着とみなす
      if (inRangeSince.current == null) inRangeSince.current = Date.now();
      else if (Date.now() - inRangeSince.current > 3000) {
        setArrived((was) => {
          // 画面を見ていなくても気づけるよう、初めて到着したときだけ振動させる
          if (!was) navigator.vibrate?.([120, 60, 120]);
          return true;
        });
      }
    } else {
      inRangeSince.current = null;
    }
  }, [fix, route, trip]);

  /* ---------------- 画面座標 ---------------- */

  const highlight = useMemo(() => {
    const s = new Set<string>();
    if (trip?.dest) s.add(trip.dest.buildingId);
    if (trip?.origin.kind === "place") s.add(trip.origin.hit.buildingId);
    if (focusId) s.add(focusId);
    return s;
  }, [trip, focusId]);

  /** 一覧に出す建物。号館を番号順、そのあと屋外・施設を指定の順で並べる */
  const listed = useMemo(() => {
    if (!data) return [];
    return [...data.buildings.features]
      .map((f) => ({
        f,
        label: f.properties.name || (f.properties.code ? `${f.properties.code}号館` : ""),
        key: orderKey(f.properties.name ?? "", f.properties.code ?? ""),
      }))
      .filter((x) => x.label)
      .sort(
        (a, b) =>
          a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2].localeCompare(b.key[2], "ja"),
      );
  }, [data]);

  /** 一覧から選んだ建物へ寄せる */
  const focusBuilding = useCallback((ring: Position[], id: string) => {
    const map = mapRef.current;
    if (!map) return;
    setFocusId(id);
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 120, maxZoom: 19, duration: 700 },
    );
  }, []);

  const view = useMemo(() => {
    const map = mapRef.current;
    if (!map || !ready || !data) return null;
    void tick;
    const p = (c: Position) => {
      const q = map.project([c[0], c[1]]);
      return { x: q.x, y: q.y };
    };
    return {
      // 建物は枠線を描かず、名前だけ地図に置く。
      // 形のデータは検索と経路に使うので、画面に出さないだけ。
      buildings: data.buildings.features.map((f) => ({
        f,
        c: p(centroid(f.geometry.coordinates[0])),
      })),
      routePts: route && !("error" in route) ? route.path.map((id) => p(graph!.pos.get(id)!)) : [],
      goal: route && !("error" in route) ? p(route.goal.geometry.coordinates) : null,
      start:
        route && !("error" in route) && graph ? p(graph.pos.get(route.startId)!) : null,
      me: fix ? p(fix.pos) : null,
      meR: fix ? radiusPx(map, fix.pos, fix.accuracy) : 0,
    };
  }, [ready, data, tick, route, graph, fix]);

  /* ---------------- 表示 ---------------- */

  const routeLine = view?.routePts.map((q) => `${q.x},${q.y}`).join(" ") ?? "";

  return (
    <div className="relative w-full select-none" style={{ height: "100dvh" }}>
      <div ref={boxRef} style={{ position: "absolute", inset: 0 }} />

      {/* 起動時のタイトル。触ると上下に割れて地図が現れる */}
      {splash !== "done" && (
        <div
          onClick={closeSplash}
          role="button"
          aria-label="はじめる"
          className="fixed inset-0 z-50 cursor-pointer"
          style={{ animation: "kitFade 500ms ease-out" }}
        >
          {/* 上半分。中身は画面全体の高さを持たせ、割れ目で切り取る */}
          <div
            className="absolute inset-x-0 top-0 h-1/2 overflow-hidden bg-slate-950"
            style={{
              transition: "transform 400ms cubic-bezier(0.65,0,0.35,1)",
              transform: splash === "closing" ? "translateY(-100%)" : "none",
            }}
          >
            <div className="absolute inset-x-0 top-0 flex h-[100dvh] flex-col items-center justify-center">
              <SplashInner />
            </div>
          </div>

          {/* 下半分 */}
          <div
            className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden bg-slate-950"
            style={{
              transition: "transform 400ms cubic-bezier(0.65,0,0.35,1)",
              transform: splash === "closing" ? "translateY(100%)" : "none",
            }}
          >
            <div className="absolute inset-x-0 bottom-0 flex h-[100dvh] flex-col items-center justify-center">
              <SplashInner />
            </div>
          </div>

          {/* 割れ目に走る細い光 */}
          <div
            className="absolute inset-x-0 top-1/2 h-px bg-white/40"
            style={{
              transition: "opacity 400ms ease-out",
              opacity: splash === "closing" ? 0 : 1,
            }}
          />
        </div>
      )}

      {fatal && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-100 p-6">
          <div className="max-w-sm rounded-2xl bg-white p-5 text-sm shadow-xl ring-1 ring-red-300">
            <b className="text-red-700">地図を表示できません</b>
            <p className="mt-2 text-xs text-slate-700">{fatal}</p>
          </div>
        </div>
      )}

      {/* 建物・経路・現在地。建物名は出さない */}
      {view && (
        <svg
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 5 }}
          width="100%"
          height="100%"
        >
          {/* 経路。薄い青を4枚重ねて、光っているように見せる */}
          {view.routePts.length > 1 && (
            <>
              <polyline points={routeLine} fill="none" stroke="#7dd3fc" strokeWidth={30} strokeOpacity={0.18} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={routeLine} fill="none" stroke="#7dd3fc" strokeWidth={20} strokeOpacity={0.3} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={routeLine} fill="none" stroke="#bae6fd" strokeWidth={12} strokeOpacity={0.65} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={routeLine} fill="none" stroke="#38bdf8" strokeWidth={6} strokeOpacity={0.95} strokeLinecap="round" strokeLinejoin="round" />
            </>
          )}

          {view.start && (
            <circle cx={view.start.x} cy={view.start.y} r={8} fill="#ffffff" stroke="#38bdf8" strokeWidth={4} />
          )}
          {view.goal && (
            <circle cx={view.goal.x} cy={view.goal.y} r={10} fill="#f97316" stroke="#ffffff" strokeWidth={3.5} />
          )}

          {view.me && (
            <>
              <circle cx={view.me.x} cy={view.me.y} r={view.meR} fill="#38bdf8" fillOpacity={0.12} />
              <circle
                cx={view.me.x}
                cy={view.me.y}
                r={9}
                fill="#38bdf8"
                stroke="#ffffff"
                strokeWidth={3.5}
                opacity={fix && fix.accuracy <= ACC_TRUST ? 1 : 0.55}
              />
            </>
          )}
        </svg>
      )}

      {/* 建物名。枠線は描かず、名前だけ置く */}
      {view && (
        <div className="pointer-events-none absolute inset-0" style={{ zIndex: 6 }}>
          {view.buildings.map(({ f, c }) => {
            const on = highlight.has(f.properties.tempId);
            const cat = categoryOf(f.properties.category);
            const label = f.properties.name || f.properties.code;
            if (!label) return null;
            return (
              // ラベルを押すとその建物へ寄る。
              // 親は pointer-events-none なので、ここだけ auto に戻す
              <button
                key={f.properties.tempId}
                onClick={() => focusBuilding(f.geometry.coordinates[0], f.properties.tempId)}
                className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold shadow-sm transition active:scale-95 ${
                  on ? "bg-orange-500 text-white" : "bg-white/85 text-slate-800 hover:bg-white"
                }`}
                style={{ left: c.x, top: c.y, borderColor: cat.lineColor }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* 左上に縦に積む。重なりが起きないよう1つの列にまとめる */}
      <div className="absolute left-4 top-4 z-10 flex w-fit max-w-[16rem] flex-col items-start gap-2">
        <button
          onClick={startWatch}
          className="flex items-center gap-2 rounded-full bg-white/95 px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-md backdrop-blur transition hover:bg-white active:scale-95"
        >
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              geoState === "on" ? "bg-blue-500" : geoState === "asking" ? "bg-amber-400" : "bg-slate-300"
            }`}
          />
          現在地
        </button>

        <button
          onClick={() => setPanel(true)}
          className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-slate-800 active:scale-95"
        >
          案内
        </button>

        {/* 学内の情報。四角いボタンを押すと横に開く */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => setSide((v) => !v)}
            aria-label="学内の情報"
            className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-1 rounded-xl bg-white/95 shadow-md backdrop-blur transition hover:bg-white active:scale-95"
          >
            <span className={`block h-0.5 w-5 rounded-full bg-slate-700 transition ${side ? "translate-y-[6px] rotate-45" : ""}`} />
            <span className={`block h-0.5 w-5 rounded-full bg-slate-700 transition ${side ? "opacity-0" : ""}`} />
            <span className={`block h-0.5 w-5 rounded-full bg-slate-700 transition ${side ? "-translate-y-[6px] -rotate-45" : ""}`} />
          </button>

          {side && (
            <div className="w-52 rounded-2xl bg-white/95 p-3 shadow-xl backdrop-blur">
              <div className="mb-2 text-[11px] font-bold text-slate-500">学内の情報</div>
              <div className="flex flex-col gap-1">
                {["食堂のメニュー", "授業予定", "空き教室"].map((label) => (
                  <button
                    key={label}
                    onClick={() => setLogin(true)}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    {label}
                    <span className="text-xs text-slate-400">🔒</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-500">
                閲覧には管理者の承認が必要です。
              </p>
              <button
                onClick={() => setLogin(true)}
                className="mt-2 w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800"
              >
                ログイン
              </button>
            </div>
          )}
        </div>

        {/* 現在地の状態。原因ごとに何をすればよいか分かるように出す */}
        {geoState !== "idle" && (
          <div className="max-w-[16rem] rounded-2xl bg-white/95 px-3 py-1.5 text-[11px] font-medium leading-relaxed text-slate-600 shadow-sm backdrop-blur">
            {geoState === "asking" && "現在地を取得中…（初回は30秒ほどかかります）"}
            {geoState === "rough" && (
              <>
                精度を上げています… ±{Math.round(fix?.accuracy ?? 0)}m
                <span className="block text-[10px] text-slate-400">
                  屋外に出て少し待つと精度が上がります
                </span>
              </>
            )}
            {geoState === "on" &&
              (inCampus === false ? "圏外（キャンパス外）" : `±${Math.round(fix?.accuracy ?? 0)}m`)}
            {geoState === "denied" && (
              <>
                現在地が拒否されています
                <span className="block text-[10px] text-slate-400">
                  iPhone：設定 → プライバシー → 位置情報サービス → Safari を「確認」か「許可」に
                </span>
              </>
            )}
            {geoState === "timeout" && (
              <>
                時間内に測位できませんでした
                <span className="block text-[10px] text-slate-400">
                  屋内では取得しにくくなります。もう一度お試しください
                </span>
              </>
            )}
            {geoState === "unavailable" && "現在地を取得できませんでした"}
            {geoState === "insecure" && (
              <>
                この接続では現在地を使えません
                <span className="block text-[10px] text-slate-400">
                  Safari などは HTTPS でないと位置情報を許可しません。
                  公開URL（https://）から開いてください
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ログイン。フェーズ2で実際に動くようにする */}
      {login && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-base font-bold tracking-tight text-slate-900">ログイン</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              大学のアカウントのみ利用できます。承認された学生・教職員が対象です。
            </p>
            <a
              href="/login"
              className="mt-3 block w-full rounded-xl bg-blue-600 px-4 py-2.5 text-center text-sm font-bold text-white transition hover:bg-blue-700"
            >
              ログイン画面へ
            </a>
            <button
              onClick={() => setLogin(false)}
              className="mt-2 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 建物一覧。下からせり上がって広がる */}
      {listed.length > 0 && (
        <div
          className="absolute inset-x-0 bottom-0 z-10 overflow-hidden rounded-t-3xl bg-white/95 shadow-2xl backdrop-blur"
          style={{
            height: listOpen ? "58dvh" : "3.25rem",
            transition: "height 350ms cubic-bezier(0.32,0.72,0,1)",
          }}
        >
          <button
            onClick={() => setListOpen((v) => !v)}
            // 上下のスワイプ／ホイールでも開閉できるようにする
            onWheel={(e) => setListOpen(e.deltaY < 0)}
            onTouchStart={(e) => {
              touchY.current = e.touches[0].clientY;
            }}
            onTouchMove={(e) => {
              if (touchY.current == null) return;
              const dy = touchY.current - e.touches[0].clientY;
              if (Math.abs(dy) < 24) return; // 誤反応を防ぐ
              setListOpen(dy > 0); // 上へ動かせば開く
              touchY.current = null;
            }}
            onTouchEnd={() => {
              touchY.current = null;
            }}
            className="w-full px-4 pb-2 pt-2.5 transition hover:bg-slate-50"
          >
            <span className="mx-auto mb-1.5 block h-1 w-10 rounded-full bg-slate-300" />
            <span className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-slate-700">
              建物一覧
              <span className="font-normal text-slate-400">{listed.length}</span>
              <span
                className="text-slate-400 transition"
                style={{ transform: listOpen ? "rotate(180deg)" : "none" }}
              >
                ▲
              </span>
            </span>
          </button>

          {/* 開いているときだけ中身を出す。2列にして一覧性を上げる */}
          <div
            className="h-[calc(58dvh-3.25rem)] overflow-y-auto overscroll-contain px-3 pb-4"
            style={{ opacity: listOpen ? 1 : 0, transition: "opacity 200ms" }}
          >
            <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {listed.map(({ f, label }) => {
                const on = focusId === f.properties.tempId;
                return (
                  <li key={f.properties.tempId}>
                    <div
                      className={`flex overflow-hidden rounded-lg ${
                        on ? "bg-orange-500" : "bg-slate-100"
                      }`}
                    >
                      {/* 名前を押すとその場所へ寄る */}
                      <button
                        onClick={() =>
                          focusBuilding(f.geometry.coordinates[0], f.properties.tempId)
                        }
                        className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-[12px] font-medium transition ${
                          on ? "text-white" : "text-slate-700 hover:bg-slate-200"
                        }`}
                      >
                        {label}
                      </button>
                      {/* ［案内］を押すだけでそこへの案内が始まる */}
                      <button
                        onClick={() => {
                          const dest = {
                            buildingId: f.properties.tempId,
                            title: label,
                            sub: "",
                            score: 0,
                          };
                          setOrigin({ kind: "me" });
                          setDest(dest);
                          setTrip({ origin: { kind: "me" }, dest });
                          setArrived(false);
                          setFocusId(f.properties.tempId);
                          setListOpen(false);
                          startWatch();
                        }}
                        className={`shrink-0 px-2.5 text-[11px] font-bold transition ${
                          on
                            ? "bg-orange-600 text-white hover:bg-orange-700"
                            : "bg-slate-200 text-slate-600 hover:bg-blue-600 hover:text-white"
                        }`}
                      >
                        案内
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {/* 出典表示。地理院タイルの利用条件で必須。一覧に隠れない位置に置く */}
      <span className="absolute bottom-0.5 right-1.5 z-30 rounded bg-white/70 px-1 text-[9px] text-slate-600">
        地理院タイル
      </span>

      {/* 到着。見逃さないよう画面の中央に大きく出す */}
      {arrived && trip && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-sm">
          <div
            className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-2xl"
            style={{ animation: "kitPop 320ms cubic-bezier(0.16,1,0.3,1)" }}
          >
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-2xl text-white">
              ✓
            </div>
            <p className="mt-3 text-[11px] font-semibold tracking-widest text-emerald-600">
              到着しました
            </p>
            <p className="mt-1 text-lg font-bold leading-snug text-slate-900">
              {trip.dest.title}
            </p>
            {trip.dest.sub && (
              <p className="mt-2 rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-800">
                {trip.dest.title.split(" ").pop()} は {trip.dest.sub}です
              </p>
            )}
            <button
              onClick={() => {
                setArrived(false);
                setTrip(null);
              }}
              className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800"
            >
              案内を終える
            </button>
            <button
              onClick={() => setArrived(false)}
              className="mt-1.5 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              地図に戻る
            </button>
          </div>
        </div>
      )}

      {/* 経路検索のパネル */}
      {panel && data && (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
          <div className="mt-4 w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h1 className="text-base font-bold tracking-tight text-slate-900">KIT map</h1>
              <button
                onClick={() => setPanel(false)}
                className="rounded-full px-3 py-1 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
              >
                閉じる
              </button>
            </div>

            <Field
              label="出発地"
              data={data}
              value={origin.kind === "me" ? "現在地" : origin.hit.title}
              allowMe
              onMe={() => setOrigin({ kind: "me" })}
              onPick={(h) => setOrigin({ kind: "place", hit: h })}
            />
            <div className="h-2" />
            <Field
              label="目的地"
              data={data}
              value={dest?.title ?? ""}
              onPick={(h) => setDest(h)}
            />

            {/* 教室は承認された人だけが見られる。未ログインには理由を伝える */}
            {!canViewCampusInfo(role) && (
              <p className="mt-2 rounded-xl bg-slate-100 p-2.5 text-[10px] leading-relaxed text-slate-500">
                いまは<b>建物どうしの案内</b>だけ使えます。
                教室（何号館の何階の何番）で探すには、
                <a href="/login" className="font-bold text-blue-600 underline">
                  ログイン
                </a>
                して管理者の承認を受けてください。
              </p>
            )}

            <button
              disabled={!dest}
              onClick={() => {
                if (!dest) return;
                if (origin.kind === "me") startWatch();
                setTrip({ origin, dest });
                setArrived(false);
                setPanel(false);
              }}
              className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.99] disabled:bg-slate-200 disabled:text-slate-400"
            >
              {dest ? "案内をはじめる" : "目的地を選んでください"}
            </button>
          </div>
        </div>
      )}

      {/* 案内中。手順の一覧は出さず、地図の道と最小限の情報だけ見せる */}
      {trip && (
        <div className="absolute bottom-16 left-4 z-20 w-[min(18rem,calc(100%-2rem))]">
          <div className="flex items-center gap-2 rounded-full bg-white/95 py-2 pl-4 pr-2 shadow-md backdrop-blur">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold leading-tight text-slate-900">
                {trip.dest.title}
              </div>
              <div className="truncate text-[11px] leading-tight text-slate-500">
                {route && !("error" in route)
                  ? `${route.fromGate ? "正門" : trip.origin.kind === "me" ? "現在地" : trip.origin.hit.title} から 徒歩${route.minutes}分・${route.meters}m`
                  : route && "error" in route
                    ? route.error
                    : "計算中…"}
              </div>
            </div>
            <button
              onClick={() => {
                setTrip(null);
                setArrived(false);
              }}
              aria-label="案内を終える"
              className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-200"
            >
              ✕
            </button>
          </div>

          {/* 目的地の階だけ、到着後の迷いを防ぐために添える */}
          {trip.dest.sub && (
            <div className="mt-1.5 w-fit rounded-full bg-slate-900/85 px-3 py-1 text-[11px] font-bold text-white shadow backdrop-blur">
              {trip.dest.title.split(" ").pop()} は {trip.dest.sub}
            </div>
          )}

        </div>
      )}
    </div>
  );
}

/** 起動画面の中身。上下の半分に同じものを置き、割れ目で切り取って1つに見せる */
function SplashInner() {
  return (
    <>
      <div
        className="text-4xl font-light tracking-[0.18em] text-white"
        style={{ animation: "kitRise 900ms cubic-bezier(0.16,1,0.3,1)" }}
      >
        KIT<span className="ml-2 font-semibold">map</span>
      </div>
      <div className="mt-10 text-[10px] tracking-wider text-white/25">
        金沢工業大学 扇が丘キャンパス
      </div>
    </>
  );
}

/* ---------------- 場所を選ぶ欄 ---------------- */

function Field({
  label,
  data,
  value,
  allowMe,
  onMe,
  onPick,
}: {
  label: string;
  data: AppData;
  value: string;
  allowMe?: boolean;
  onMe?: () => void;
  onPick: (h: SearchHit) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => (q ? search(data, q) : []), [data, q]);

  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-500">{label}</label>
      <input
        value={open ? q : value}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQ("");
          setOpen(true);
        }}
        placeholder="23号館 / 23 302 / 図書館"
        className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:bg-white focus:ring-2 focus:ring-blue-500"
      />
      {open && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
          {allowMe && (
            <li>
              <button
                onClick={() => {
                  onMe?.();
                  setOpen(false);
                }}
                className="w-full px-4 py-2.5 text-left text-sm font-semibold text-blue-600 transition hover:bg-slate-50"
              >
                現在地を使う
              </button>
            </li>
          )}
          {hits.map((h, i) => (
            <li key={`${h.buildingId}-${i}`}>
              <button
                onClick={() => {
                  onPick(h);
                  setOpen(false);
                }}
                className="w-full px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
              >
                <span className="font-semibold text-slate-900">{h.title}</span>
                {h.sub && <span className="ml-2 text-xs text-slate-500">{h.sub}</span>}
              </button>
            </li>
          ))}
          {q && hits.length === 0 && (
            <li className="px-4 py-3 text-xs text-slate-400">見つかりません</li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ---------------- 一覧の並び順 ---------------- */

/** 号館のあとに並べる順番。実データの表記に合わせてある */
const TAIL_ORDER = [
  "自転車(北)",
  "自転車(北2)",
  "自転車(東)",
  "自転車(東2)",
  "自転車(西)",
  "自転車(南)",
  "テニスコート",
  "グラウンド",
  "金沢工業大学前バス停",
];

/** 全角半角の括弧ゆれを吸収して比べる */
const plain = (s: string) => s.replace(/[（）()\s]/g, "");
const TAIL_KEYS = TAIL_ORDER.map(plain);

/**
 * 並び順のキー。
 * ① 号館を番号順（1, 2, 3, 5 …）
 *    名前に「6号館」を含むもの（LC(6号館) など）は 6 の直後に置く
 * ② それ以外の建物
 * ③ 自転車・テニスコート・グラウンド・バス停を指定の順
 */
function orderKey(name: string, code: string): [number, number, string] {
  if (code && /^\d+$/.test(code)) return [0, Number(code), ""];

  const i = TAIL_KEYS.indexOf(plain(name));
  if (i >= 0) return [2, i, ""];

  // 番号は無いが「◯号館」と名乗るものは、その号館の直後に差し込む
  const m = /(\d+)\s*号館/.exec(name);
  if (m) return [0, Number(m[1]) + 0.5, ""];

  return [1, 0, name];
}

/* ---------------- 補助 ---------------- */

/** リングの平均座標。ラベルの置き場所に使う（厳密な重心でなくてよい） */
function centroid(ring: Position[]): Position {
  const pts = ring.slice(0, -1);
  const s = pts.reduce<[number, number]>((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
}

/** メートルを画面上のピクセル半径に直す */
function radiusPx(map: MlMap, at: Position, meters: number): number {
  const a = map.project([at[0], at[1]]);
  const b = map.project([at[0], at[1] + meters / 111320]);
  return Math.abs(a.y - b.y);
}
