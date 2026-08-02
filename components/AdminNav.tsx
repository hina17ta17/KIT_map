"use client";

/**
 * 管理画面の見出しと、行き先のボタン。
 *
 * 画面ごとに小さな文字の並びで行き来していたが、押しにくく、
 * どこへ行けるのかも分かりにくかった。
 * 見出しの右上には必ず「地図へ」を置き、行き先は上から縦に並べる。
 *
 * 権限が足りないものは出さない。押せないものが並んでいても迷うだけなので、
 * その人が使えるものだけを見せる。
 */

import Link from "next/link";
import { canManage, canManageCafeteria, type Role } from "@/lib/auth";

export type AdminPageId = "approve" | "rooms" | "schedule" | "cafeteria";

type Entry = {
  id: AdminPageId;
  href: string;
  icon: string;
  label: string;
  sub: string;
  allowed: (role: Role | null) => boolean;
};

const ENTRIES: Entry[] = [
  {
    id: "approve",
    href: "/admin",
    icon: "✓",
    label: "承認・権限の管理",
    sub: "利用申請の承認と、権限の変更",
    allowed: canManage,
  },
  {
    id: "rooms",
    href: "/admin/rooms",
    icon: "🏫",
    label: "教室の登録",
    sub: "何号館の何階に、どの教室があるか",
    allowed: (r) => r === "admin_l3",
  },
  {
    id: "schedule",
    href: "/admin/schedule",
    icon: "📘",
    label: "予定の登録",
    sub: "授業・イベント・課外活動",
    allowed: (r) => r === "admin_l1" || r === "admin_l2" || r === "admin_l3",
  },
  {
    id: "cafeteria",
    href: "/admin/cafeteria",
    icon: "🍚",
    label: "食堂のメニュー",
    sub: "その日の提供状況と品名",
    allowed: canManageCafeteria,
  },
];

/** 画面の見出し。右上には必ず地図へ戻る道を置く */
export function AdminHeader({ title }: { title: string }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <h1 className="text-lg font-bold text-slate-900">{title}</h1>
      <Link
        href="/"
        className="shrink-0 rounded-full bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 active:scale-95"
      >
        地図へ
      </Link>
    </div>
  );
}

/**
 * 行き先を上から縦に並べる。
 *
 * 使える権限のあるものだけを出す。current を渡さなければ、
 * どこも「開いている」扱いにしない（ログイン画面から使うときなど）。
 */
export function AdminMenu({
  current,
  role,
}: {
  current?: AdminPageId;
  role: Role | null;
}) {
  const usable = ENTRIES.filter((e) => e.allowed(role));
  if (usable.length === 0) return null;

  return (
    <nav className="mb-4 flex flex-col gap-2">
      {usable.map((e) => {
        const here = e.id === current;

        if (here) {
          return (
            <div
              key={e.id}
              className="flex items-center gap-3 rounded-xl bg-slate-900 px-3 py-3 text-left"
            >
              <span className="text-lg">{e.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-white">{e.label}</span>
                <span className="block text-[10px] text-slate-300">いま開いています</span>
              </span>
            </div>
          );
        }

        return (
          <Link
            key={e.id}
            href={e.href}
            className="flex items-center gap-3 rounded-xl bg-slate-100 px-3 py-3 text-left transition hover:bg-slate-200 active:scale-95"
          >
            <span className="text-lg">{e.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-800">{e.label}</span>
              <span className="block text-[10px] text-slate-500">{e.sub}</span>
            </span>
            <span className="ml-auto shrink-0 text-slate-400">›</span>
          </Link>
        );
      })}
    </nav>
  );
}
