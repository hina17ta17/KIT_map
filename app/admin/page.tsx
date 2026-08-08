"use client";

/**
 * 承認と権限の管理（Lv3だけが使える）。
 *
 * ■ 二つの見方
 *   新規 … まだ承認していない人。まとめて権限を付けられる
 *   既存 … すでに使っている人。年・クラス・組で絞って見る
 *
 * すでに使っている人の権限を変えるときは操作パスワードが要る。
 * 押し間違いで一括降格させる事故を、ひと手間で防ぐため。
 *
 * 管理者Lv3 はここからは付けられない。データベースから設定する。
 * 画面から付けられると、Lv3 を乗っ取られた時点で全部を握られるため。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { CLASS_CODES, GRADES, GROUPS, ROLE_LABEL, ROLE_SHORT, canManage, type Role } from "@/lib/auth";

type Row = {
  id: string;
  email: string;
  role: Role;
  full_name: string;
  grade: number;
  class_code: string;
  group_no: number;
  verified: boolean;
  created_at: string;
};

/** ここから付けられる権限。Lv3 は入れない */
const ASSIGNABLE: Role[] = ["pending", "student", "admin_l0", "admin_l1", "admin_l2"];

const SHORT = ROLE_SHORT;

export default function AdminPage() {
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<"new" | "existing">("new");
  /** チェックを入れた人 */
  const [picked, setPicked] = useState<string[]>([]);
  /** 既存を変えるときの合言葉 */
  const [password, setPassword] = useState("");

  /* 既存の絞り込み */
  const [fGrade, setFGrade] = useState<number | null>(null);
  const [fClass, setFClass] = useState<string | null>(null);
  const [fGroup, setFGroup] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setMyRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase.from("profiles").select("role").eq("id", u.user.id).single();
    const role = (me?.role as Role) ?? null;
    setMyRole(role);

    if (canManage(role)) {
      // 列を並べずに取る。010 を流す前でも落ちないようにするため
      const { data } = await supabase.from("profiles").select("*").order("created_at");
      setRows((data as Row[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const news = useMemo(() => rows.filter((r) => r.role === "pending"), [rows]);
  const existing = useMemo(() => rows.filter((r) => r.role !== "pending"), [rows]);

  const shown = useMemo(() => {
    if (tab === "new") return news;
    return existing.filter(
      (r) =>
        (fGrade === null || r.grade === fGrade) &&
        (fClass === null || r.class_code === fClass) &&
        (fGroup === null || r.group_no === fGroup),
    );
  }, [tab, news, existing, fGrade, fClass, fGroup]);

  /** まとめて権限を付ける */
  const apply = async (role: Role) => {
    setMsg(null);
    if (picked.length === 0) {
      setMsg({ kind: "err", text: "誰も選ばれていません" });
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("set_roles", {
        p_ids: picked,
        p_role: role,
        p_password: password || null,
      });
      if (error) throw error;
      setPicked([]);
      setPassword("");
      await load();
      setMsg({ kind: "ok", text: `${data ?? 0}名を「${ROLE_LABEL[role]}」にしました` });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "変更できませんでした" });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">サーバーに接続できません。</p></Shell>;

  if (!myRole)
    return (
      <Shell>
        <p className="text-sm text-slate-700">ログインしていません。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">ログインへ</Link>
      </Shell>
    );

  if (!canManage(myRole))
    return (
      <Shell>
        <p className="text-sm text-slate-700">この画面は管理者（Lv3）だけが使えます。</p>
        <p className="mt-1 text-xs text-slate-500">現在の権限：{ROLE_LABEL[myRole]}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">地図へ戻る</Link>
      </Shell>
    );

  const needPassword = tab === "existing";

  return (
    <Shell wide>
      <AdminHeader title="承認・権限の管理" />
      <AdminMenu current="approve" role={myRole} />

      {/* 新規 / 既存 */}
      <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1">
        {([
          ["new", `新規の申請（${news.length}）`],
          ["existing", `既存（${existing.length}）`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setPicked([]);
              setMsg(null);
            }}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition ${
              tab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 既存の絞り込み */}
      {tab === "existing" && (
        <div className="mb-3 rounded-xl bg-slate-50 p-2.5">
          <Filter label="学年" value={fGrade} onPick={setFGrade} options={GRADES.map((g) => [g, `${g}年`])} />
          <Filter
            label="クラス"
            value={fClass}
            onPick={setFClass}
            options={CLASS_CODES.map((c) => [c.code, c.code])}
          />
          <Filter label="組" value={fGroup} onPick={setFGroup} options={GROUPS.map((g) => [g, `${g}`])} />
        </div>
      )}

      <p className="mb-2 text-[11px] text-slate-500">
        {shown.length} 名
        {picked.length > 0 && <b className="ml-2 text-blue-700">{picked.length} 名を選択中</b>}
      </p>

      {/* 一覧 */}
      <ul className="space-y-1.5">
        {shown.map((r) => {
          const on = picked.includes(r.id);
          const locked = r.role === "admin_l3";
          return (
            <li key={r.id}>
              <button
                disabled={locked}
                onClick={() =>
                  setPicked((p) => (on ? p.filter((x) => x !== r.id) : [...p, r.id]))
                }
                className={`flex w-full items-start gap-2 rounded-xl p-2.5 text-left ring-1 transition ${
                  locked
                    ? "bg-slate-50 ring-slate-200 opacity-60"
                    : on
                      ? "bg-blue-50 ring-blue-300"
                      : r.role === "pending"
                        ? "bg-amber-50 ring-amber-200 hover:bg-amber-100"
                        : "bg-white ring-slate-200 hover:bg-slate-50"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${
                    on ? "bg-blue-600 text-white" : "bg-white text-transparent ring-1 ring-slate-300"
                  }`}
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">
                    {r.full_name || "（氏名未記入）"}
                    {!r.verified && (
                      <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-700">
                        本人確認まだ
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">{r.email}</span>
                  <span className="mt-0.5 block text-[10px] text-slate-500">
                    {r.grade ? `${r.grade}年 ` : ""}
                    {r.class_code}
                    {r.group_no ? `-${r.group_no}` : ""}
                    <span className="ml-2 font-bold text-slate-600">{SHORT[r.role]}</span>
                    {locked && <span className="ml-1 text-slate-400">（変更はデータベースから）</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-500">
            該当する人がいません
          </li>
        )}
      </ul>

      {/* まとめて権限を付ける */}
      <div className="sticky bottom-0 mt-4 rounded-2xl bg-white/95 pt-3 backdrop-blur">
        {needPassword && (
          <>
            <div className="mb-1 text-[11px] font-bold text-slate-500">操作パスワード</div>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="すでに承認した人を変えるには必要です"
              className="mb-2 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
          </>
        )}
        <div className="grid grid-cols-5 gap-1.5">
          {ASSIGNABLE.map((role) => (
            <button
              key={role}
              disabled={busy || picked.length === 0}
              onClick={() => void apply(role)}
              className="rounded-lg bg-slate-900 px-1 py-2.5 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {SHORT[role]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
          選んだ人にまとめて付けます。
          <b>管理者Lv3 はここからは付けられません</b>（データベースから設定してください）。
        </p>
        {msg && (
          <p
            className={`mt-2 rounded-xl p-3 text-xs leading-relaxed ${
              msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
            }`}
          >
            {msg.text}
          </p>
        )}
      </div>
    </Shell>
  );
}

/* ---------------- 絞り込みの一行 ---------------- */

function Filter<T extends string | number>({
  label,
  value,
  onPick,
  options,
}: {
  label: string;
  value: T | null;
  onPick: (v: T | null) => void;
  options: [T, string][];
}) {
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-1 text-[10px] font-bold text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        <Chip on={value === null} onClick={() => onPick(null)}>
          すべて
        </Chip>
        {options.map(([v, text]) => (
          <Chip key={String(v)} on={value === v} onClick={() => onPick(v)}>
            {text}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
        on ? "bg-slate-900 text-white" : "bg-white text-slate-600 shadow-sm hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    // 本文は地図のために overflow-hidden。ここで送れるようにする
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-2xl" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
