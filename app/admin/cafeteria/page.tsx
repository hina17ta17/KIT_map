"use client";

/**
 * 食堂のメニューの設定（Lv0 と Lv3）。
 *
 * 日を選んでから、どの項目を設定するかを選ぶ。
 * 提供口は「活動中／活動休止」の二択、枠は品名を書く。
 *
 * 画面で出し分けてはいるが、守っているのは RLS。
 * Lv0 と Lv3 以外は書き込めない。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { ROLE_LABEL, canManageCafeteria, type Role } from "@/lib/auth";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function sameDay(a: Date, b: Date) {
  return ymd(a) === ymd(b);
}

type Item = {
  id: number;
  kind: "counter" | "slot";
  parent_id: number | null;
  name: string;
  sort_order: number;
};

/** 提供口の状態。二択で選べるようにする */
const STATES = [
  { id: "open", label: "活動中", cls: "bg-emerald-600" },
  { id: "closed", label: "活動休止", cls: "bg-slate-600" },
] as const;

export default function CafeteriaAdminPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  /** 日を選ぶところから始める */
  const [date, setDate] = useState<Date | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  /** いま設定している項目 */
  const [target, setTarget] = useState<Item | null>(null);

  const [states, setStates] = useState<Map<number, string>>(new Map());
  const [menus, setMenus] = useState<Map<number, { name: string; price: number | null }>>(new Map());

  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /* 入力欄 */
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
    void (async () => {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        setLoading(false);
        return;
      }
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", u.user.id)
        .single();
      setRole((me?.role as Role) ?? null);

      const { data } = await supabase
        .from("cafeteria_items")
        .select("id, kind, parent_id, name, sort_order")
        .order("sort_order");
      setItems((data as Item[]) ?? []);
      setLoading(false);
    })();
  }, []);

  /** その日の登録済みを読む */
  const loadDay = useCallback(async (d: Date) => {
    const supabase = createClient();
    const [a, b] = await Promise.all([
      supabase.from("counter_days").select("item_id, state").eq("on_date", ymd(d)),
      supabase.from("menu_days").select("item_id, name, price").eq("on_date", ymd(d)),
    ]);
    setStates(new Map(((a.data as { item_id: number; state: string }[]) ?? []).map((r) => [r.item_id, r.state])));
    setMenus(
      new Map(
        ((b.data as { item_id: number; name: string; price: number | null }[]) ?? []).map((r) => [
          r.item_id,
          { name: r.name, price: r.price },
        ]),
      ),
    );
  }, []);

  /* 項目を選んだら、いまの中身を入力欄に写す */
  useEffect(() => {
    if (!target) return;
    const m = menus.get(target.id);
    setName(m?.name ?? "");
    setPrice(m?.price != null ? String(m.price) : "");
    setMsg(null);
  }, [target, menus]);

  const counters = useMemo(() => items.filter((i) => i.kind === "counter"), [items]);

  /* ---------------- 保存 ---------------- */

  const saveState = async (item: Item, state: string) => {
    if (!date) return;
    setBusy(true);
    setMsg(null);
    const { error } = await createClient()
      .from("counter_days")
      .upsert({ item_id: item.id, on_date: ymd(date), state }, { onConflict: "item_id,on_date" });
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    setStates((prev) => new Map(prev).set(item.id, state));
    setMsg({ kind: "ok", text: `${item.name} を「${STATES.find((s) => s.id === state)?.label}」にしました` });
  };

  const saveMenu = async () => {
    if (!date || !target) return;
    if (!name.trim()) {
      setMsg({ kind: "err", text: "名称を入れてください" });
      return;
    }
    setBusy(true);
    setMsg(null);
    const { error } = await createClient().from("menu_days").upsert(
      {
        item_id: target.id,
        on_date: ymd(date),
        name: name.trim(),
        price: price.trim() ? Number(price) : null,
      },
      { onConflict: "item_id,on_date" },
    );
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    setMenus((prev) =>
      new Map(prev).set(target.id, { name: name.trim(), price: price.trim() ? Number(price) : null }),
    );
    setMsg({ kind: "ok", text: `${target.name} を「${name.trim()}」にしました` });
  };

  const clearMenu = async () => {
    if (!date || !target) return;
    setBusy(true);
    const { error } = await createClient()
      .from("menu_days")
      .delete()
      .eq("item_id", target.id)
      .eq("on_date", ymd(date));
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    setMenus((prev) => {
      const n = new Map(prev);
      n.delete(target.id);
      return n;
    });
    setName("");
    setPrice("");
    setMsg({ kind: "ok", text: `${target.name} の登録を消しました` });
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">サーバーに接続できません。</p></Shell>;

  if (!role)
    return (
      <Shell>
        <p className="text-sm text-slate-700">ログインしていません。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">ログインへ</Link>
      </Shell>
    );

  if (!canManageCafeteria(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">
          食堂の設定ができるのは、管理者Lv0 と Lv3 だけです。
        </p>
        <p className="mt-1 text-xs text-slate-500">現在の権限：{ROLE_LABEL[role]}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">地図へ戻る</Link>
      </Shell>
    );

  return (
    <Shell wide>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-900">食堂のメニュー</h1>
        <div className="flex gap-3 text-xs font-semibold text-slate-500">
          <Link href="/admin" className="hover:text-slate-800">承認</Link>
          <Link href="/" className="hover:text-slate-800">地図</Link>
        </div>
      </div>

      {/* ---- 1. 日を選ぶ ---- */}
      {!date && (
        <>
          <p className="mb-2 text-[11px] font-bold text-slate-500">まず日を選んでください</p>
          <Cal
            onPick={(d) => {
              setDate(d);
              setTarget(null);
              void loadDay(d);
            }}
          />
        </>
      )}

      {date && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <button
              onClick={() => {
                if (target) setTarget(null);
                else setDate(null);
              }}
              className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200"
            >
              ← {target ? "項目を選び直す" : "日を選び直す"}
            </button>
            <button
              onClick={() => {
                setDate(null);
                setTarget(null);
              }}
              className="text-xs font-bold text-slate-800 underline decoration-slate-300 underline-offset-2"
            >
              {date.getFullYear()}年{date.getMonth() + 1}月{date.getDate()}日（{WEEK[date.getDay()]}）
            </button>
          </div>

          {/* ---- 2. 項目を選ぶ ---- */}
          {!target && (
            <>
              <p className="mb-2 text-[11px] font-bold text-slate-500">
                どの項目を設定しますか
              </p>
              <div className="flex flex-col gap-2">
                {counters.map((c) => {
                  const st = states.get(c.id);
                  const slots = items.filter((i) => i.parent_id === c.id);
                  return (
                    <div key={c.id} className="rounded-xl bg-slate-50 p-2">
                      <button
                        onClick={() => setTarget(c)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-white"
                      >
                        <span className="text-sm font-bold text-slate-900">{c.name}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${
                            st === "open"
                              ? "bg-emerald-600"
                              : st === "closed"
                                ? "bg-slate-600"
                                : st === "soldout"
                                  ? "bg-red-600"
                                  : "bg-slate-300"
                          }`}
                        >
                          {st === "open"
                            ? "活動中"
                            : st === "closed"
                              ? "活動休止"
                              : st === "soldout"
                                ? "売り切れ"
                                : "未設定"}
                        </span>
                      </button>

                      {slots.map((s) => {
                        const m = menus.get(s.id);
                        return (
                          <button
                            key={s.id}
                            onClick={() => setTarget(s)}
                            className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white"
                          >
                            <span className="shrink-0 text-[11px] text-slate-500">− {s.name}</span>
                            <span className="min-w-0 truncate text-right text-[11px] font-bold text-slate-800">
                              {m ? m.name : "未設定"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {counters.length === 0 && (
                  <p className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-500">
                    食堂の項目が登録されていません。
                  </p>
                )}
              </div>
            </>
          )}

          {/* ---- 3. 設定する ---- */}
          {target && (
            <div>
              <p className="mb-1 text-xs font-bold text-slate-900">{target.name}</p>

              {target.kind === "counter" ? (
                <>
                  <p className="mb-2 text-[11px] text-slate-500">
                    この日の状態を選んでください
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {STATES.map((s) => {
                      const on = states.get(target.id) === s.id;
                      return (
                        <button
                          key={s.id}
                          disabled={busy}
                          onClick={() => void saveState(target, s.id)}
                          className={`rounded-xl py-4 text-sm font-bold transition active:scale-95 ${
                            on ? `${s.cls} text-white` : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                          }`}
                        >
                          {s.label}
                          {on && <span className="mt-0.5 block text-[10px] font-normal">選択中</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <p className="mb-2 text-[11px] text-slate-500">
                    この日の名称を入れてください
                  </p>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="味噌カツ丼"
                    className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={price}
                      onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
                      inputMode="numeric"
                      placeholder="450"
                      className="w-28 rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-xs font-bold text-slate-500">円（任意）</span>
                  </div>
                  <button
                    onClick={() => void saveMenu()}
                    disabled={busy}
                    className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
                  >
                    {busy ? "保存中…" : "保存する"}
                  </button>
                  {menus.get(target.id) && (
                    <button
                      onClick={() => void clearMenu()}
                      disabled={busy}
                      className="mt-1.5 w-full rounded-xl px-4 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                    >
                      この日の登録を消す
                    </button>
                  )}
                </>
              )}

              {msg && (
                <p
                  className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${
                    msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
                  }`}
                >
                  {msg.text}
                </p>
              )}
            </div>
          )}

          {!target && msg && (
            <p
              className={`mt-3 rounded-xl p-3 text-xs ${
                msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
              }`}
            >
              {msg.text}
            </p>
          )}
        </>
      )}
    </Shell>
  );
}

/* ---------------- カレンダー ---------------- */

function Cal({ onPick }: { onPick: (d: Date) => void }) {
  const today = useMemo(() => new Date(), []);
  const [shown, setShown] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const cells = useMemo(() => {
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    const last = new Date(shown.getFullYear(), shown.getMonth() + 1, 0);
    const out: (Date | null)[] = [];
    for (let i = 0; i < first.getDay(); i++) out.push(null);
    for (let d = 1; d <= last.getDate(); d++)
      out.push(new Date(shown.getFullYear(), shown.getMonth(), d));
    return out;
  }, [shown]);

  const move = (n: number) =>
    setShown((s) => new Date(s.getFullYear(), s.getMonth() + n, 1));

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => move(-1)}
          className="h-9 w-9 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 hover:bg-slate-200"
        >
          ‹
        </button>
        <span className="flex-1 text-center text-sm font-bold text-slate-800">
          {shown.getFullYear()}年 {shown.getMonth() + 1}月
        </span>
        <button
          onClick={() => move(1)}
          className="h-9 w-9 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 hover:bg-slate-200"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEK.map((w, i) => (
          <div
            key={w}
            className={`py-1 text-[10px] font-bold ${
              i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-slate-400"
            }`}
          >
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const isToday = sameDay(d, today);
          return (
            <button
              key={ymd(d)}
              onClick={() => onPick(d)}
              className={`aspect-square rounded-lg text-sm font-bold transition active:scale-90 ${
                isToday
                  ? "bg-amber-100 text-amber-900 ring-2 ring-amber-400"
                  : d.getDay() === 0
                    ? "text-red-500 hover:bg-slate-100"
                    : d.getDay() === 6
                      ? "text-blue-500 hover:bg-slate-100"
                      : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      <button
        onClick={() => onPick(new Date())}
        className="mt-3 w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-amber-600"
      >
        今日（{today.getMonth() + 1}/{today.getDate()}）を設定する
      </button>
    </div>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    // 本文は地図のために overflow-hidden。ここで送れるようにする
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-lg" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
