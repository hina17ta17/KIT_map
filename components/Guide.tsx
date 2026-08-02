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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MlMap, NavigationControl, ScaleControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Position } from "geojson";
import { BASES, GSI_ATTRIBUTION, INITIAL_VIEW } from "@/lib/gsi";
import { categoryOf, type CheckpointFeature } from "@/lib/features";
import { loadAppData, loadRooms, search, type AppData, type SearchHit } from "@/lib/appdata";
import { ROLE_LABEL, canViewCampusInfo, type Role } from "@/lib/auth";
import { buildGraph, buildSteps, findBestPath, nearestNode } from "@/lib/route";
import CampusPanel from "./CampusPanel";
import { metersBetween } from "@/lib/geo";

/** 精度の扱い。推測で決めず3段階に分ける */
const ACC_TRUST = 20;
const ACC_ROUGH = 50;
/** 現在地からこの距離以内に経路の節点が無ければ案内できない */
const SNAP_MAX = 50;
/** 起動時の縮尺。建物を押して寄ったあと、ここへ戻す */
const HOME_ZOOM = 17;

/** 画面の上での名前の置き場所。左上を起点にした四角 */
type LabelBox = { x: number; y: number; w: number; h: number };

/**
 * 名前がどれだけの場所を取るかの見積もり。
 *
 * 本当の幅は描いてみないと分からないが、毎回測ると描き直しが増える。
 * 11px の太字なら、全角はほぼ文字の高さ分、半角はその6割ほどの幅になる。
 * 左右の余白 16px を足したものを、その名前の占める幅とみなす。
 */
function labelBox(text: string, x: number, y: number): LabelBox {
  let w = 16;
  for (const ch of text) w += /[ -~｡-ﾟ]/.test(ch) ? 6.6 : 11;
  const h = 19;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** 二つの名前がぶつかるか。詰まって見えないよう少し隙間を見込む */
function overlaps(a: LabelBox, b: LabelBox, gap = 3): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  );
}

/** 右上の狭い場所に出す用の、短い権限名 */
const SHORT_ROLE: Record<Role, string> = {
  pending: "承認待ち",
  student: "学生・教職員",
  admin_l0: "管理者Lv0",
  admin_l1: "管理者Lv1",
  admin_l2: "管理者Lv2",
  admin_l3: "管理者Lv3",
};

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
  /** 向いている方角。真北を0として時計回りの度数。分からなければ null */
  const [heading, setHeading] = useState<number | null>(null);
  /** 方位磁針をもう読み始めたか */
  const compassOn = useRef(false);
  const [geoState, setGeoState] = useState<
    "idle" | "asking" | "on" | "rough" | "denied" | "timeout" | "unavailable" | "insecure"
  >("idle");
  const watchId = useRef<number | null>(null);
  /** 応答が無いまま黙るのを防ぐための見張り */
  const retryTimer = useRef<number | null>(null);

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
  /** ログインしている人のメールアドレス。未ログインなら null */
  const [email, setEmail] = useState<string | null>(null);
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
        zoom: HOME_ZOOM,
        maxZoom: 21,
        // これ以上引いても構内の案内には使えない。
        // 引ききった先で二本指を動かすと、地図が受け取らなくなった指の動きを
        // ブラウザがページの拡大とみなしてしまうため、行き止まりを作らない
        minZoom: 15,
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

  /**
   * ページ自体が拡大されるのを止める。
   *
   * iOS の Safari は viewport の `user-scalable=no` を無視する。
   * 二本指の動きが地図に届かなかったとき——引ききった先や、
   * 建物の名前など地図の上に重ねた部品から始めたとき——
   * Safari はそれをページの拡大とみなす。
   * するとページ全体の倍率が上がり、地図はそのままなのに
   * 名前やボタンだけが大きくなる。
   *
   * Safari だけが出すこの合図を断ると、拡大は起きない。
   */
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    const kinds = ["gesturestart", "gesturechange", "gestureend"];
    for (const k of kinds) document.addEventListener(k, stop, { passive: false });
    return () => {
      for (const k of kinds) document.removeEventListener(k, stop);
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
        setEmail(u.user.email ?? null);

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

  /** 位置を受け取ったときの共通処理 */
  const accept = useCallback((p: GeolocationPosition) => {
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
    // 進んでいるときは、位置から向きが分かることがある。
    // 止まっていると null や NaN が来るので、そのときは触らない
    const h = p.coords.heading;
    if (h != null && Number.isFinite(h) && (p.coords.speed ?? 0) > 0.5) {
      setHeading(h);
    }
    // 粗いあいだも位置は出す（円で誤差を正直に見せる）
    setGeoState(acc > ACC_ROUGH ? "rough" : "on");
  }, []);

  /**
   * 端末の向き（方位磁針）を読み始める。
   *
   * 位置から分かる向きは歩いている間しか取れない。止まっていても
   * どちらを向いているか出したいので、方位磁針からも取る。
   *
   * iOS は許可を求める必要があり、その求め方はタップと同じ流れで
   * 呼ばないと拒まれる。現在地のボタンから一緒に呼ぶ。
   */
  const startCompass = useCallback(() => {
    if (compassOn.current) return;

    const onOrient = (ev: DeviceOrientationEvent) => {
      // iOS は真北からの角度をそのままくれる。
      // Android は alpha が反時計回りなので、向きを合わせる
      const ios = (ev as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      if (ios != null && Number.isFinite(ios)) {
        setHeading(ios);
        return;
      }
      if (ev.absolute && ev.alpha != null && Number.isFinite(ev.alpha)) {
        setHeading((360 - ev.alpha) % 360);
      }
    };

    const attach = () => {
      compassOn.current = true;
      window.addEventListener("deviceorientationabsolute", onOrient as EventListener);
      window.addEventListener("deviceorientation", onOrient as EventListener);
    };

    const anyDOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof anyDOE?.requestPermission === "function") {
      // 断られても現在地そのものは使えるので、黙って諦める
      void anyDOE.requestPermission().then((r) => {
        if (r === "granted") attach();
      }).catch(() => {});
    } else if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      attach();
    }
  }, []);

  /**
   * 現在地の取得を始める。
   *
   * iOS Safari の落とし穴に合わせてある。
   *  ・許可を求める呼び出しは、タップと同じ処理の流れで行う必要がある
   *    （await をはさむと許可ダイアログが出ないことがある）
   *  ・watchPosition から始めると、一度も呼ばれないまま黙ることがある。
   *    まず getCurrentPosition で許可を取り、成功してから追従を始める
   *  ・一度失敗したあと押し直しても何も起きない状態になりやすいので、
   *    位置がまだ無いときは前の監視を止めて必ずやり直す
   */
  const startWatch = useCallback(() => {
    // 押した時点で描画面を測り直す。
    // 許可ダイアログでアドレスバーの高さが変わり、地図が半分のまま残るのを防ぐ
    mapRef.current?.resize();
    setTick((v) => v + 1);
    // 向きの許可も、このタップと同じ流れで求める
    startCompass();

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setGeoState("insecure");
      return;
    }
    if (!navigator.geolocation) {
      setGeoState("unavailable");
      return;
    }

    // すでに位置が取れていて追従中なら、そこへ寄せるだけ
    if (watchId.current != null && fix) {
      mapRef.current?.easeTo({ center: [fix.pos[0], fix.pos[1]], zoom: 18 });
      return;
    }
    // 取れていないのに監視だけ残っている＝失敗している。止めてやり直す
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (retryTimer.current != null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    setGeoState("asking");

    const beginWatch = () => {
      if (watchId.current != null) return;
      watchId.current = navigator.geolocation.watchPosition(
        accept,
        (err) => {
          // 追従中の一時的な失敗で、取れている位置を消さない
          if (err.code === err.PERMISSION_DENIED) setGeoState("denied");
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
      );
    };

    const fail = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setGeoState("denied");
        return;
      }
      // 高精度が取れない場所（屋内・ビルの谷間）では粗い位置で妥協する
      navigator.geolocation.getCurrentPosition(
        (p) => {
          accept(p);
          beginWatch();
        },
        (e2) => setGeoState(e2.code === e2.TIMEOUT ? "timeout" : "unavailable"),
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 },
      );
    };

    // ★ここがタップと同じ流れで呼ばれることが重要。許可ダイアログはこれで出る
    navigator.geolocation.getCurrentPosition(
      (p) => {
        accept(p);
        beginWatch();
      },
      fail,
      // 衛星をつかむには時間がいる。初回は特に、電源を入れてすぐだと
      // 20〜30秒かかることがある。ここを短くすると、衛星を待たずに
      // Wi-Fi や基地局からの粗い位置に落ちてしまう
      { enableHighAccuracy: true, maximumAge: 0, timeout: 25_000 },
    );

    // 何も返らないときは、黙らせずに状態を出す。
    // 上の待ち時間より長くしないと、待っている最中に諦めたことになる
    retryTimer.current = window.setTimeout(() => {
      setFix((cur) => {
        if (!cur) setGeoState("timeout");
        return cur;
      });
    }, 32_000);
  }, [fix, accept, startCompass]);

  /** 許可の状態を先に調べて、拒否されているなら押す前に伝える */
  useEffect(() => {
    void navigator.permissions
      ?.query({ name: "geolocation" as PermissionName })
      .then((s) => {
        if (s.state === "denied") setGeoState("denied");
        s.onchange = () => {
          if (s.state === "denied") setGeoState("denied");
        };
      })
      .catch(() => {
        // Safari の古い版は未対応。押したときに分かるので何もしない
      });
  }, []);

  useEffect(
    () => () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      if (retryTimer.current != null) clearTimeout(retryTimer.current);
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
    // 敷地は一面とはかぎらない。どれかに入っていれば圏内とする
    const polys = data.campus.features
      .map((f) => f.geometry.coordinates[0])
      .filter((p) => p && p.length > 2);
    if (polys.length === 0) return null;
    return polys.some((poly) => inRing(poly, fix.pos));
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

    /* 起点。建物から出るときは、その建物の出入口すべてを候補にする */
    let startIds: string[] = [];
    let fromGate = false;
    if (trip.origin.kind === "me") {
      const near = fix && inCampus !== false ? nearestNode(graph, fix.pos, SNAP_MAX)?.id : null;
      if (near) startIds = [near];
      // 現在地がまだ取れていなくても案内は出す。門を起点にして、そう伝える
      if (startIds.length === 0) {
        const gate = (data.checkpoints.features as CheckpointFeature[]).find(
          (c) => c.properties.kind === "gate",
        );
        if (gate) {
          startIds = [gate.properties.id];
          fromGate = true;
        }
      }
      if (startIds.length === 0) return { error: "経路の起点が見つかりません" as const };
    } else {
      const ents = entrancesOf(trip.origin.hit.buildingId);
      if (ents.length === 0) return { error: "出発地の入口が登録されていません" as const };
      startIds = ents.map((e) => e.properties.id);
    }

    /* 目的地の出入口すべて */
    const ents = entrancesOf(trip.dest.buildingId);
    if (ents.length === 0) return { error: "目的地の入口が登録されていません" as const };

    // 出入口の組み合わせをすべて見比べて、道なりでいちばん短くなるものを選ぶ。
    // 直線で近い出入口が道なりでも近いとはかぎらない
    const found = findBestPath(
      graph,
      startIds,
      ents.map((e) => e.properties.id),
    );
    if (!found) return { error: "経路が見つかりませんでした" as const };

    const path = found.path;
    const startId = path[0];
    const goal = ents.find((e) => e.properties.id === path[path.length - 1]) ?? ents[0];

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

  /**
   * 経路が出たら、道すじ全体が入るところまで引く。
   *
   * 出発地に寄ったままだと、どこへ向かうのかが画面の外で分からない。
   * 同じ経路で何度も動かすと操作の邪魔になるので、
   * 道すじが変わったときだけ動かす。
   */
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!trip) {
      fittedFor.current = null;
      return;
    }
    if (!map || !route || "error" in route || !graph) return;

    const key = route.path.join(">");
    if (fittedFor.current === key) return;
    fittedFor.current = key;

    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    const add = (c: Position) => {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    };
    for (const id of route.path) {
      const q = graph.pos.get(id);
      if (q) add(q);
    }
    add(route.goal.geometry.coordinates);
    if (!Number.isFinite(w)) return;

    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        // 上はボタン、下は案内の帯と建物一覧が重なるので、その分を空ける
        padding: { top: 140, bottom: 200, left: 56, right: 56 },
        maxZoom: 18,
        duration: 800,
      },
    );
  }, [trip, route, graph]);

  /* ---------------- 画面座標 ---------------- */

  const highlight = useMemo(() => {
    const s = new Set<string>();
    if (trip?.dest) s.add(trip.dest.buildingId);
    if (trip?.origin.kind === "place") s.add(trip.origin.hit.buildingId);
    if (focusId) s.add(focusId);
    return s;
  }, [trip, focusId]);

  /**
   * 建物の広さ。名前をどれから先に置くかを決めるためだけに使う。
   *
   * 経緯度のまま計算するので実際の面積ではないが、
   * 大小の順さえ合っていればよい。動かすたびに計算し直さないよう一度だけ求める。
   */
  const areaOf = useMemo(() => {
    const m = new Map<string, number>();
    if (!data) return m;
    for (const f of data.buildings.features) {
      const ring = f.geometry.coordinates[0];
      let s = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      m.set(f.properties.tempId, Math.abs(s) / 2);
    }
    return m;
  }, [data]);

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

  /**
   * 建物へ寄せる。押すたびに寄る／戻るが入れ替わる。
   *
   * 同じ建物をもう一度押したら、起動したときの見え方へ戻す。
   * 寄ったあと元に戻す手立てが無いと、指で縮めるしかなくなるため。
   */
  const focusBuilding = useCallback(
    (ring: Position[], id: string) => {
      const map = mapRef.current;
      if (!map) return;

      if (focusId === id) {
        setFocusId(null);
        // 中心は動かさず、縮尺だけ戻す。
        // 決まった場所へ引き戻すと、いま見ていた建物が画面から消えて
        // どこを見ていたか分からなくなる。押した建物を真ん中に置いたまま引く。
        map.easeTo({
          zoom: HOME_ZOOM,
          bearing: 0,
          pitch: 0,
          duration: 700,
        });
        return;
      }

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
    },
    [focusId],
  );

  const view = useMemo(() => {
    const map = mapRef.current;
    if (!map || !ready || !data) return null;
    void tick;
    const p = (c: Position) => {
      const q = map.project([c[0], c[1]]);
      return { x: q.x, y: q.y };
    };
    /*
     * 建物は枠線を描かず、名前だけ地図に置く。
     * 形のデータは検索と経路に使うので、画面に出さないだけ。
     *
     * 縮尺を下げると、離れた建物の名前どうしが画面の上で重なって読めなくなる。
     * そこで大事なものから順に場所を取っていき、すでに置いた名前と
     * ぶつかるものは出さない。出せなかった名前は、拡大すれば場所が空いて出てくる。
     */
    const canvas = map.getContainer();
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const zoom = map.getZoom();

    const taken: LabelBox[] = [];
    const buildings: { f: (typeof data.buildings.features)[number]; c: { x: number; y: number } }[] =
      [];

    const cands = data.buildings.features
      .map((f) => ({
        f,
        c: p(centroid(f.geometry.coordinates[0])),
        text: f.properties.name || f.properties.code || "",
      }))
      // 画面の外は判定にも描画にも要らない。少しはみ出す分だけ余裕を持たせる。
      // 構内から離れた場所は、寄ったときだけ出す
      .filter(
        (x) =>
          x.text &&
          (zoom >= ZOOM_ONLY_AT || !ZOOM_ONLY_NAMES.has(x.f.properties.name ?? "")) &&
          x.c.x > -80 &&
          x.c.y > -40 &&
          x.c.x < W + 80 &&
          x.c.y < H + 40,
      )
      .sort((a, b) => {
        // 選んでいる建物と経路の両端は、何を押したか分からなくなるので必ず出す
        const ah = highlight.has(a.f.properties.tempId) ? 1 : 0;
        const bh = highlight.has(b.f.properties.tempId) ? 1 : 0;
        if (ah !== bh) return bh - ah;
        // あとは大きい建物から。小さな小屋より号館の方が目印になる
        return (areaOf.get(b.f.properties.tempId) ?? 0) - (areaOf.get(a.f.properties.tempId) ?? 0);
      });

    for (const x of cands) {
      const r = labelBox(x.text, x.c.x, x.c.y);
      if (taken.some((t) => overlaps(t, r))) continue;
      taken.push(r);
      buildings.push({ f: x.f, c: x.c });
    }

    return {
      buildings,
      routePts: route && !("error" in route) ? route.path.map((id) => p(graph!.pos.get(id)!)) : [],
      goal: route && !("error" in route) ? p(route.goal.geometry.coordinates) : null,
      start:
        route && !("error" in route) && graph ? p(graph.pos.get(route.startId)!) : null,
      me: fix ? p(fix.pos) : null,
      meR: fix ? radiusPx(map, fix.pos, fix.accuracy) : 0,
    };
  }, [ready, data, tick, route, graph, fix, highlight, areaOf]);

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

              {/* 向いている方角。丸の上にとがった先を重ねる。
                  地図を回していても正しい方角を指すよう、地図の向きを差し引く */}
              {heading != null && (
                <g
                  transform={`translate(${view.me.x},${view.me.y}) rotate(${
                    heading - (mapRef.current?.getBearing() ?? 0)
                  })`}
                >
                  {/* 進む先へ広がる薄い光。どちらを向いているか遠目にも分かる */}
                  <path
                    d="M -13 -16 A 20 20 0 0 1 13 -16 L 0 -40 Z"
                    fill="#38bdf8"
                    opacity={0.22}
                  />
                  {/* とがった先 */}
                  <path
                    d="M 0 -20 L 7 -8 L 0 -11 L -7 -8 Z"
                    fill="#38bdf8"
                    stroke="#ffffff"
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                </g>
              )}
            </>
          )}

          {/* 目的地。ひと目で分かるよう、赤いピンを大きく立てる。
              現在地より手前に描いて隠れないようにする */}
          {view.goal && (
            <g transform={`translate(${view.goal.x},${view.goal.y})`}>
              {/* 地面の影。浮いて見えると場所が曖昧になる */}
              <ellipse cx={0} cy={1} rx={10} ry={4} fill="#0f172a" opacity={0.28} />
              {/* しずく形。とがった先が目的地を指す */}
              <path
                d="M0 0 C -7 -13, -18 -22, -18 -34 A 18 18 0 1 1 18 -34 C 18 -22, 7 -13, 0 0 Z"
                fill="#ef4444"
                stroke="#ffffff"
                strokeWidth={3.5}
                strokeLinejoin="round"
              />
              <circle cx={0} cy={-34} r={6.5} fill="#ffffff" />
            </g>
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

      {/* 右上に、いま誰で入っているかを出す。押すと自分の状態と
          ログアウトを見られる画面へ行く */}
      {email && (
        <a
          href="/login"
          className="absolute right-4 top-4 z-10 flex max-w-[11rem] items-center gap-2 rounded-full bg-white/95 py-1.5 pl-2 pr-3 shadow-md backdrop-blur transition hover:bg-white active:scale-95"
          title={`${email}（${ROLE_LABEL[role ?? "pending"]}）`}
        >
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
              canViewCampusInfo(role) ? "bg-blue-600" : "bg-amber-500"
            }`}
          >
            {email.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[11px] font-bold leading-tight text-slate-800">
              {email}
            </span>
            <span className="block truncate text-[9px] leading-tight text-slate-500">
              {SHORT_ROLE[role ?? "pending"]}でログイン中
            </span>
          </span>
        </a>
      )}

      {/* 学内の情報。
          ボタンの列の中に入れると、列の幅と高さに縛られて
          下のほうが画面の外に出てしまう。上下を画面に留めた
          別の引き出しにして、中身は必ず送れるようにする */}
      {side && (
        <div
          className="absolute left-4 z-20 flex w-[min(21rem,calc(100vw-2rem))] flex-col rounded-2xl bg-white/95 p-3 shadow-2xl backdrop-blur"
          style={{ top: "1rem", bottom: "1rem" }}
        >
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500">学内の情報</span>
            <button
              onClick={() => setSide(false)}
              aria-label="閉じる"
              className="h-7 w-7 rounded-lg bg-slate-100 text-xs font-bold text-slate-600 transition hover:bg-slate-200"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <CampusPanel role={role} onNeedLogin={() => setLogin(true)} />
          </div>
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
        </div>

        {/* 現在地の状態。原因ごとに何をすればよいか分かるように出す */}
        {geoState !== "idle" && (
          <div className="max-w-[16rem] rounded-2xl bg-white/95 px-3 py-1.5 text-[11px] font-medium leading-relaxed text-slate-600 shadow-sm backdrop-blur">
            {geoState === "asking" && "現在地を取得中…（初回は30秒ほどかかります）"}
            {geoState === "rough" && (
              <>
                精度を上げています… ±{Math.round(fix?.accuracy ?? 0)}m
                <span className="block text-[10px] text-slate-400">
                  いまは Wi-Fi や基地局からの推定です。
                  空の見える場所で少し待つと、衛星に切り替わります
                </span>
              </>
            )}
            {/* 精度から、衛星で測れているのか電波からの推定なのかを伝える。
                どの衛星を使ったかはブラウザからは分からないが、
                この精度なら衛星が効いている、という目安にはなる */}
            {geoState === "on" &&
              (inCampus === false ? (
                "圏外（キャンパス外）"
              ) : (
                <>
                  ±{Math.round(fix?.accuracy ?? 0)}m
                  <span className="block text-[10px] text-emerald-600">
                    衛星で測れています（GPS・みちびき等）
                  </span>
                </>
              ))}
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
                測位できませんでした
                <button
                  onClick={startWatch}
                  className="mt-1 block rounded-full bg-slate-900 px-3 py-1 text-[10px] font-bold text-white"
                >
                  もう一度試す
                </button>
                <span className="mt-1 block text-[10px] text-slate-400">
                  屋内では取得しにくくなります。窓際か屋外でお試しください
                </span>
              </>
            )}
            {geoState === "denied" && (
              <button
                onClick={startWatch}
                className="mt-1 block rounded-full bg-slate-900 px-3 py-1 text-[10px] font-bold text-white"
              >
                許可し直したら押す
              </button>
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
              {listed.map(({ f, label, key }, i) => {
                const on = focusId === f.properties.tempId;
                // 区切りが変わったところに見出しを挟む。
                // 列をまたいで一行使いたいので col-span-full にする
                const head =
                  key[0] !== listed[i - 1]?.key[0] ? GROUP_LABEL[key[0]] : undefined;
                return (
                  <Fragment key={f.properties.tempId}>
                    {head && (
                      <li className="col-span-full mt-2 first:mt-0">
                        <div className="border-t border-slate-200 pb-1 pt-2 text-[10px] font-bold text-slate-400">
                          {head}
                        </div>
                      </li>
                    )}
                  <li>
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
                  </Fragment>
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
            {/* 「✕」だけでは何が消えるのか分からないので、言葉で書く */}
            <button
              onClick={() => {
                setTrip(null);
                setArrived(false);
                setFocusId(null);
              }}
              className="shrink-0 rounded-full bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800 active:scale-95"
            >
              案内を消す
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
];

/**
 * 「その他」としてまとめるもの。
 *
 * 構内の建物ではなく、行き帰りに使う場所。
 * 号館や施設に混ぜると探しにくいので、末尾に分けて置く。
 */
const OTHER_ORDER = ["金沢工業大学前バス停", "野々市工大前駅", "バス停"];

/**
 * 点が輪の中にあるか。辺との交差数が奇数なら中にいる。
 * 敷地が複数あるので、面ごとにこれで確かめる。
 */
function inRing(poly: Position[], at: Position): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > at[1] !== yj > at[1] && at[0] < ((xj - xi) * (at[1] - yi)) / (yj - yi) + xi) {
      ins = !ins;
    }
  }
  return ins;
}

/**
 * 拡大したときだけ地図に名前を出す建物。
 *
 * 構内から離れた場所なので、引いた状態では出さない。
 * 出しっぱなしにすると、遠くの名前が構内の名前と場所を取り合ってしまう。
 * 建物の一覧にはいつでも出す。
 */
const ZOOM_ONLY_NAMES = new Set(["野々市工大前駅", "バス停"]);
/** この縮尺より寄ったら、上の名前も出す */
const ZOOM_ONLY_AT = 17.5;

/** 全角半角の括弧ゆれを吸収して比べる */
const plain = (s: string) => s.replace(/[（）()\s]/g, "");
const TAIL_KEYS = TAIL_ORDER.map(plain);
const OTHER_KEYS = OTHER_ORDER.map(plain);

/** 一覧の区切り。数が小さいほど上に出る */
export const GROUP = { hall: 0, plain: 1, tail: 2, other: 3 } as const;

/** 区切りの見出し。号館には見出しを付けない（先頭なので要らない） */
const GROUP_LABEL: Record<number, string> = {
  [GROUP.tail]: "施設",
  [GROUP.other]: "その他",
};

/**
 * 並び順のキー。
 * ① 号館を番号順（1, 2, 3, 5 …）
 *    名前に「6号館」を含むもの（LC(6号館) など）は 6 の直後に置く
 * ② それ以外の建物
 * ③ 自転車・テニスコート・グラウンドを指定の順
 * ④ その他（バス停・駅）を指定の順
 */
function orderKey(name: string, code: string): [number, number, string] {
  if (code && /^\d+$/.test(code)) return [GROUP.hall, Number(code), ""];

  const o = OTHER_KEYS.indexOf(plain(name));
  if (o >= 0) return [GROUP.other, o, ""];

  const i = TAIL_KEYS.indexOf(plain(name));
  if (i >= 0) return [GROUP.tail, i, ""];

  // 番号は無いが「◯号館」と名乗るものは、その号館の直後に差し込む
  const m = /(\d+)\s*号館/.exec(name);
  if (m) return [GROUP.hall, Number(m[1]) + 0.5, ""];

  return [GROUP.plain, 0, name];
}

export { GROUP_LABEL };

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
