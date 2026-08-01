"use client";

/**
 * 地図が真っ白になる原因を切り分けるための診断ページ。
 *
 * 本番の作図画面（/）は Tailwind・状態管理・レイヤ定義が絡むため、
 * どこで失敗しているか分からない。ここでは
 *   React描画 → WebGL2 → タイル取得 → maplibre読込 → 地図生成 → load
 * を1段ずつ確認し、結果を画面に出す。Tailwind に依存しないよう
 * すべてインラインスタイルで書いてある。
 */

import { useEffect, useRef, useState } from "react";

type Step = { name: string; state: "…" | "OK" | "NG"; detail?: string };

const TILE = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/16/57394/25844.jpg";

export default function TestPage() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [steps, setSteps] = useState<Step[]>([
    { name: "1. React が描画された", state: "OK" },
    { name: "2. WebGL2 が使える", state: "…" },
    { name: "3. 地理院タイルを取得できる", state: "…" },
    { name: "4. maplibre-gl を読み込めた", state: "…" },
    { name: "5. 地図オブジェクトを作れた", state: "…" },
    { name: "6. 地図の load が発火した", state: "…" },
  ]);

  const set = (i: number, state: Step["state"], detail?: string) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, state, detail } : s)));

  useEffect(() => {
    let disposed = false;

    void (async () => {
      // --- 2. WebGL2 ---
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2");
      if (!gl) {
        const gl1 = probe.getContext("webgl");
        set(1, "NG", gl1 ? "WebGL1 のみ。MapLibre は WebGL2 が必要" : "WebGL が全く使えない");
        return;
      }
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      set(1, "OK", dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "利用可");

      // --- 3. タイル取得（ネットワーク／プロキシ／CORS の切り分け）---
      try {
        const res = await fetch(TILE, { mode: "cors" });
        set(2, res.ok ? "OK" : "NG", `HTTP ${res.status}`);
      } catch (e) {
        set(2, "NG", `通信失敗: ${e instanceof Error ? e.message : String(e)}`);
      }

      // --- 4. ライブラリ読込 ---
      let mod: typeof import("maplibre-gl");
      try {
        await import("maplibre-gl/dist/maplibre-gl.css");
        mod = await import("maplibre-gl");
        set(3, "OK", typeof mod.Map === "function" ? "Map クラスあり" : "Map クラスが無い");
      } catch (e) {
        set(3, "NG", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return;
      }

      if (disposed || !boxRef.current) return;

      // --- 5. 地図生成 ---
      let map: InstanceType<typeof mod.Map>;
      try {
        map = new mod.Map({
          container: boxRef.current,
          center: [136.6294, 36.5316],
          zoom: 16,
          style: {
            version: 8,
            sources: {
              photo: {
                type: "raster",
                tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
                tileSize: 256,
                maxzoom: 18,
                attribution: "地理院タイル",
              },
            },
            layers: [{ id: "photo", type: "raster", source: "photo" }],
          },
        });
        set(4, "OK");
      } catch (e) {
        set(4, "NG", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return;
      }

      map.on("error", (e) => set(5, "NG", e.error?.message ?? "地図エラー"));
      map.on("load", () => set(5, "OK", "タイルが見えていれば正常"));

      return () => map.remove();
    })();

    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 12px" }}>地図の診断</h1>

      <ol style={{ listStyle: "none", padding: 0, margin: "0 0 16px", fontSize: 14 }}>
        {steps.map((s) => (
          <li
            key={s.name}
            style={{
              padding: "6px 10px",
              marginBottom: 4,
              borderRadius: 6,
              background:
                s.state === "OK" ? "#dcfce7" : s.state === "NG" ? "#fee2e2" : "#f1f5f9",
              border: `1px solid ${
                s.state === "OK" ? "#86efac" : s.state === "NG" ? "#fca5a5" : "#cbd5e1"
              }`,
            }}
          >
            <b>{s.state === "OK" ? "✅" : s.state === "NG" ? "❌" : "⏳"}</b> {s.name}
            {s.detail && (
              <span style={{ marginLeft: 8, fontSize: 12, color: "#475569" }}>— {s.detail}</span>
            )}
          </li>
        ))}
      </ol>

      <p style={{ fontSize: 13, color: "#475569", margin: "0 0 8px" }}>
        下の枠に航空写真が出れば地図自体は正常です。この画面をそのまま共有してください。
      </p>

      <div
        ref={boxRef}
        style={{
          width: "100%",
          height: 400,
          border: "2px solid #0f172a",
          borderRadius: 8,
          background: "#e2e8f0",
        }}
      />
    </div>
  );
}
