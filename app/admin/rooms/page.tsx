"use client";

/**
 * 教室の登録（Lv2以上）。
 *
 * 「何号館の何階の何番の教室は何という名前か」をまとめて入れる画面。
 * シラバスからコピーした一覧をそのまま貼り付けられるようにしてある。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { FeatureCollection, Polygon } from "geojson";
import { createClient } from "@/lib/supabase/client";
import { type Role } from "@/lib/auth";
import { guessFloor, floorLabel, type BuildingProps } from "@/lib/features";

type Row = {
  id: number;
  building_id: string;
  building_code: string;
  floor: number;
  code: string;
  name: string;
  category: string;
  hint: string;
};

type Building = { tempId: string; label: string; code: string };

const CATEGORIES = [
  { id: "class", label: "教室" },
  { id: "lab", label: "研究室" },
  { id: "office", label: "事務" },
  { id: "facility", label: "設備" },
  { id: "other", label: "その他" },
];

export default function RoomsPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [target, setTarget] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [bulk, setBulk] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  /* 建物の一覧は地図データから取る */
  useEffect(() => {
    void fetch("/data/buildings.geojson")
      .then((r) => r.json())
      .then((fc: FeatureCollection<Polygon, BuildingProps>) => {
        const list = fc.features
          .map((f) => ({
            tempId: f.properties.tempId,
            code: f.properties.code ?? "",
            label: f.properties.name || `${f.properties.code}号館`,
          }))
          .filter((b) => b.label)
          .sort((a, b) => (Number(a.code) || 999) - (Number(b.code) || 999));
        setBuildings(list);
        if (list.length) setTarget(list[0].tempId);
      })
      .catch(() => setBuildings([]));
  }, []);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase.from("profiles").select("role").eq("id", u.user.id).single();
    setRole((me?.role as Role) ?? null);

    const { data } = await supabase
      .from("rooms")
      .select("id, building_id, building_code, floor, code, name, category, hint")
      .order("building_code")
      .order("floor")
      .order("code");
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canEdit = role === "admin_l2" || role === "admin_l3";

  const ofTarget = useMemo(
    () => rows.filter((r) => r.building_id === target),
    [rows, target],
  );

  /* まとめて追加 */
  const addBulk = async () => {
    setMsg(null);
    const b = buildings.find((x) => x.tempId === target);
    if (!b) return;

    const codes = bulk
      .split(/[\n,、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (codes.length === 0) return;

    const payload = codes.map((code) => ({
      building_id: b.tempId,
      building_code: b.code,
      code,
      floor: guessFloor(code),
      name: "",
      category: "class",
    }));

    // 同じ建物に同じ番号があれば飛ばす（unique 制約に任せる）
    const { error } = await createClient()
      .from("rooms")
      .upsert(payload, { onConflict: "building_id,code", ignoreDuplicates: true });

    if (error) setMsg(error.message);
    else {
      setBulk("");
      await load();
    }
  };

  const update = async (id: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const { error } = await createClient().from("rooms").update(patch).eq("id", id);
    if (error) setMsg(error.message);
  };

  const remove = async (id: number) => {
    const { error } = await createClient().from("rooms").delete().eq("id", id);
    if (error) setMsg(error.message);
    else setRows((prev) => prev.filter((r) => r.id !== id));
  };

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!canEdit)
    return (
      <Shell>
        <p className="text-sm text-slate-700">この画面は管理者（Lv2以上）だけが使えます。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          ログインへ
        </Link>
      </Shell>
    );

  const floors = [...new Set(ofTarget.map((r) => r.floor))].sort((a, b) => a - b);

  return (
    <Shell wide>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-900">教室の登録</h1>
        <div className="flex gap-3 text-xs font-semibold text-slate-500">
          <Link href="/admin" className="hover:text-slate-800">承認・権限</Link>
          <Link href="/" className="hover:text-slate-800">地図へ</Link>
        </div>
      </div>

      {msg && <p className="mb-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">{msg}</p>}

      <label className="block text-[11px] font-semibold text-slate-500">建物</label>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="mt-1 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-medium outline-none"
      >
        {buildings.map((b) => (
          <option key={b.tempId} value={b.tempId}>
            {b.label}（{rows.filter((r) => r.building_id === b.tempId).length}室）
          </option>
        ))}
      </select>

      <div className="mt-4 rounded-xl bg-slate-50 p-3">
        <p className="text-[11px] leading-relaxed text-slate-600">
          部屋番号を1行ずつ貼り付けます。<b>階は番号から自動で判定</b>します
          （302→3階、B01→地下1階）。あとから直せます。
        </p>
        <textarea
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={4}
          placeholder={"302\n301\n201"}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <button
          onClick={addBulk}
          disabled={!bulk.trim()}
          className="mt-2 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white disabled:bg-slate-300"
        >
          まとめて追加
        </button>
      </div>

      {ofTarget.length > 0 && (
        <>
          <p className="mt-4 text-[11px] text-slate-500">
            {ofTarget.length}室 ／{" "}
            {floors.map((f) => `${floorLabel(f)} ${ofTarget.filter((r) => r.floor === f).length}室`).join(" ・ ")}
          </p>
          <ul className="mt-2 space-y-1">
            {ofTarget.map((r) => (
              <li key={r.id} className="flex items-center gap-1 rounded-lg bg-white px-2 py-1.5 ring-1 ring-slate-200">
                <input
                  value={r.code}
                  onChange={(e) => update(r.id, { code: e.target.value })}
                  className="w-16 rounded border border-slate-300 px-1.5 py-1 text-xs"
                />
                <input
                  value={r.name}
                  onChange={(e) => update(r.id, { name: e.target.value })}
                  placeholder="名称（任意）"
                  className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
                />
                <input
                  type="number"
                  value={r.floor}
                  onChange={(e) => update(r.id, { floor: Number(e.target.value) })}
                  title="階。地下は -1"
                  className="w-14 rounded border border-slate-300 px-1.5 py-1 text-xs"
                />
                <select
                  value={r.category}
                  onChange={(e) => update(r.id, { category: e.target.value })}
                  className="rounded border border-slate-300 px-1 py-1 text-[11px]"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => remove(r.id)}
                  className="px-1 text-xs font-bold text-red-600 hover:text-red-800"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-[100dvh] bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-2xl" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
