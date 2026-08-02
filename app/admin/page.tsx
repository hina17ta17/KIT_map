"use client";

/**
 * 承認と権限の管理（Lv3だけが使える）。
 *
 * 画面側でも弾いているが、守っているのは RLS。
 * Lv3 以外は一覧を取得しても空が返る。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ROLE_LABEL, canManage, type Role } from "@/lib/auth";

type Row = { id: string; email: string; role: Role; created_at: string };

const ROLES: Role[] = ["pending", "student", "admin_l1", "admin_l2", "admin_l3"];

export default function AdminPage() {
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setMyRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", u.user.id)
      .single();
    const role = (me?.role as Role) ?? null;
    setMyRole(role);

    if (canManage(role)) {
      const { data } = await supabase
        .from("profiles")
        .select("id, email, role, created_at")
        .order("created_at", { ascending: true });
      setRows((data as Row[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (id: string, role: Role) => {
    setMsg(null);
    const { error } = await createClient().from("profiles").update({ role }).eq("id", id);
    if (error) {
      // 「最後のLv3は降格できません」などはここで返る
      setMsg(error.message);
      return;
    }
    await load();
  };

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!myRole)
    return (
      <Shell>
        <p className="text-sm text-slate-700">ログインしていません。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          ログインへ
        </Link>
      </Shell>
    );

  if (!canManage(myRole))
    return (
      <Shell>
        <p className="text-sm text-slate-700">この画面は管理者（Lv3）だけが使えます。</p>
        <p className="mt-1 text-xs text-slate-500">現在の権限：{ROLE_LABEL[myRole]}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">
          地図へ戻る
        </Link>
      </Shell>
    );

  const pending = rows.filter((r) => r.role === "pending");

  return (
    <Shell wide>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-900">承認・権限の管理</h1>
        <Link href="/" className="text-xs font-semibold text-slate-500 hover:text-slate-800">
          地図へ戻る
        </Link>
      </div>

      {msg && (
        <p className="mb-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">{msg}</p>
      )}

      <p className="mb-3 text-xs text-slate-500">
        全 {rows.length} 名 ／ 承認待ち <b className="text-amber-700">{pending.length}</b> 名
      </p>

      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className={`rounded-xl p-3 ring-1 ${
              r.role === "pending" ? "bg-amber-50 ring-amber-200" : "bg-white ring-slate-200"
            }`}
          >
            <div className="text-sm font-semibold text-slate-900">{r.email}</div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {ROLE_LABEL[r.role]} ／ 申請 {new Date(r.created_at).toLocaleDateString("ja-JP")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {ROLES.map((role) => (
                <button
                  key={role}
                  disabled={role === r.role}
                  onClick={() => change(r.id, role)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                    role === r.role
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {role === "pending" ? "承認待ち" : role === "student" ? "学生" : role.replace("admin_l", "Lv")}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
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
