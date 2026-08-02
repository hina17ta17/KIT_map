"use client";

/**
 * 学内の情報（食堂・時間割・空き教室）。
 *
 * まず日を選ぶところから始める。どの画面も「その日のこと」を出すので、
 * 先に日が決まっていないと何も表示できないため。
 *
 * 中身はすべてデータベースから読む。承認されていない人には
 * RLS が空を返すので、ここでは権限の分岐を最小限にしている。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { canViewCampusInfo, type Role } from "@/lib/auth";

type Step = "calendar" | "home" | "cafeteria" | "timetable" | "free";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** その日を "2026-08-05" の形にする。時差でずれないよう自前で組む */
function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function sameDay(a: Date, b: Date): boolean {
  return ymd(a) === ymd(b);
}

/** "08:40:00" → "8:40" */
function hhmm(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":");
  return `${Number(h)}:${m}`;
}

type Period = { id: number; label: string; starts_at: string; ends_at: string };

export default function CampusPanel({
  role,
  onNeedLogin,
}: {
  role: Role | null;
  onNeedLogin: () => void;
}) {
  const [step, setStep] = useState<Step>("calendar");
  const [date, setDate] = useState(() => new Date());
  const [periods, setPeriods] = useState<Period[]>([]);

  const allowed = canViewCampusInfo(role);

  useEffect(() => {
    if (!supabaseReady || !allowed) return;
    void createClient()
      .from("periods")
      .select("id, label, starts_at, ends_at")
      .order("id")
      .then(({ data }) => setPeriods((data as Period[]) ?? []));
  }, [allowed]);

  if (!supabaseReady) {
    return (
      <Note>
        サーバーに接続できていません。しばらくしてから開き直してください。
      </Note>
    );
  }

  if (!allowed) {
    return (
      <div className="p-1">
        <Note>
          学内の情報は、管理者の承認を受けた学生・教職員だけが見られます。
        </Note>
        <button
          onClick={onNeedLogin}
          className="mt-2 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800"
        >
          ログイン / 利用を申請
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {step !== "calendar" && (
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => setStep(step === "home" ? "calendar" : "home")}
            className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200"
          >
            ← 戻る
          </button>
          <button
            onClick={() => setStep("calendar")}
            className="truncate text-xs font-bold text-slate-800 underline decoration-slate-300 underline-offset-2"
          >
            {date.getFullYear()}年{date.getMonth() + 1}月{date.getDate()}日（
            {WEEK[date.getDay()]}）
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === "calendar" && (
          <Calendar
            date={date}
            onPick={(d) => {
              setDate(d);
              setStep("home");
            }}
          />
        )}

        {step === "home" && (
          <div className="flex flex-col gap-2">
            <Big onClick={() => setStep("cafeteria")} icon="🍚" label="食堂のメニュー" sub="その日の提供状況" />
            <Big onClick={() => setStep("timetable")} icon="📘" label="時間割" sub="授業と課外活動" />
            <Big onClick={() => setStep("free")} icon="🚪" label="空き教室" sub="号館と時限から探す" />
          </div>
        )}

        {step === "cafeteria" && <Cafeteria date={date} />}
        {step === "timetable" && <Timetable date={date} periods={periods} />}
        {step === "free" && <FreeRooms date={date} periods={periods} />}
      </div>
    </div>
  );
}

/* ================= カレンダー ================= */

function Calendar({ date, onPick }: { date: Date; onPick: (d: Date) => void }) {
  const today = useMemo(() => new Date(), []);
  const [shown, setShown] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1));
  /** 月の一覧を開いているか。年と月をまとめて選べる */
  const [pick, setPick] = useState(false);

  const move = (n: number) =>
    setShown((s) => new Date(s.getFullYear(), s.getMonth() + n, 1));

  // 1日の曜日ぶん空白を置いてから並べる
  const cells = useMemo(() => {
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    const last = new Date(shown.getFullYear(), shown.getMonth() + 1, 0);
    const out: (Date | null)[] = [];
    for (let i = 0; i < first.getDay(); i++) out.push(null);
    for (let d = 1; d <= last.getDate(); d++)
      out.push(new Date(shown.getFullYear(), shown.getMonth(), d));
    return out;
  }, [shown]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => move(-1)}
          aria-label="前の月"
          className="h-8 w-8 shrink-0 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200"
        >
          ‹
        </button>
        {/* 見出しを押すと、年と月をまとめて選べる。
            何か月も先を見るときに ‹ › を連打しなくて済む */}
        <button
          onClick={() => setPick((v) => !v)}
          className={`flex-1 rounded-lg py-1.5 text-sm font-bold transition ${
            pick ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-100"
          }`}
        >
          {shown.getFullYear()}年 {shown.getMonth() + 1}月 ▾
        </button>
        <button
          onClick={() => move(1)}
          aria-label="次の月"
          className="h-8 w-8 shrink-0 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200"
        >
          ›
        </button>
      </div>

      {pick ? (
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => setShown((s) => new Date(s.getFullYear() - 1, s.getMonth(), 1))}
              className="h-7 w-7 rounded-lg bg-white text-xs font-bold text-slate-600 shadow-sm"
            >
              ‹
            </button>
            <span className="text-sm font-bold text-slate-800">{shown.getFullYear()}年</span>
            <button
              onClick={() => setShown((s) => new Date(s.getFullYear() + 1, s.getMonth(), 1))}
              className="h-7 w-7 rounded-lg bg-white text-xs font-bold text-slate-600 shadow-sm"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 12 }, (_, i) => (
              <button
                key={i}
                onClick={() => {
                  setShown(new Date(shown.getFullYear(), i, 1));
                  setPick(false);
                }}
                className={`rounded-lg py-2 text-xs font-bold transition ${
                  i === shown.getMonth()
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                }`}
              >
                {i + 1}月
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-0.5 text-center">
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
              const isPicked = sameDay(d, date);
              return (
                <button
                  key={ymd(d)}
                  onClick={() => onPick(d)}
                  className={`relative aspect-square rounded-lg text-xs font-bold transition active:scale-90 ${
                    isPicked
                      ? "bg-slate-900 text-white"
                      : isToday
                        ? "bg-amber-100 text-amber-900 ring-2 ring-amber-400"
                        : d.getDay() === 0
                          ? "text-red-500 hover:bg-slate-100"
                          : d.getDay() === 6
                            ? "text-blue-500 hover:bg-slate-100"
                            : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {d.getDate()}
                  {/* 今日はひと目で分かるように、下に点を置く */}
                  {isToday && !isPicked && (
                    <span className="absolute inset-x-0 bottom-1 mx-auto block h-1 w-1 rounded-full bg-amber-500" />
                  )}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => {
              setShown(new Date(today.getFullYear(), today.getMonth(), 1));
              onPick(new Date());
            }}
            className="mt-2 w-full rounded-xl bg-amber-500 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-amber-600 active:scale-95"
          >
            今日（{today.getMonth() + 1}/{today.getDate()}）から始める
          </button>
          <p className="mt-1.5 text-center text-[10px] text-slate-400">
            日にちを押すと、その日の情報が開きます
          </p>
        </>
      )}
    </div>
  );
}

/* ================= 食堂 ================= */

type ItemRow = { id: number; kind: string; parent_id: number | null; name: string; sort_order: number };

const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  open: { text: "活動中", cls: "bg-emerald-100 text-emerald-800" },
  closed: { text: "活動休止", cls: "bg-slate-200 text-slate-600" },
  soldout: { text: "売り切れ", cls: "bg-red-100 text-red-700" },
};

function Cafeteria({ date }: { date: Date }) {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [states, setStates] = useState<Map<number, { state: string; note: string }>>(new Map());
  const [menus, setMenus] = useState<Map<number, { name: string; price: number | null }>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const d = ymd(date);
    setLoading(true);
    void (async () => {
      const supabase = createClient();
      const [a, b, c] = await Promise.all([
        supabase.from("cafeteria_items").select("id, kind, parent_id, name, sort_order").order("sort_order"),
        supabase.from("counter_days").select("item_id, state, note").eq("on_date", d),
        supabase.from("menu_days").select("item_id, name, price").eq("on_date", d),
      ]);
      setItems((a.data as ItemRow[]) ?? []);
      setStates(new Map(((b.data as { item_id: number; state: string; note: string }[]) ?? []).map((r) => [r.item_id, r])));
      setMenus(new Map(((c.data as { item_id: number; name: string; price: number | null }[]) ?? []).map((r) => [r.item_id, r])));
      setLoading(false);
    })();
  }, [date]);

  if (loading) return <Note>読み込み中…</Note>;

  const counters = items.filter((i) => i.kind === "counter");
  if (counters.length === 0) return <Note>食堂の情報がまだ登録されていません。</Note>;

  return (
    <ul className="flex flex-col gap-2">
      {counters.map((c) => {
        const st = states.get(c.id);
        const badge = st ? STATE_LABEL[st.state] : null;
        const slots = items.filter((i) => i.parent_id === c.id);
        return (
          <li key={c.id} className="rounded-xl bg-slate-50 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-slate-900">・{c.name}</span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  badge ? badge.cls : "bg-slate-100 text-slate-400"
                }`}
              >
                {badge ? badge.text : "未登録"}
              </span>
            </div>
            {st?.note && <p className="mt-1 text-[10px] text-slate-500">{st.note}</p>}

            {slots.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1 border-t border-slate-200 pt-1.5">
                {slots.map((s) => {
                  const m = menus.get(s.id);
                  return (
                    <li key={s.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="shrink-0 text-slate-500">− {s.name}</span>
                      <span className="min-w-0 truncate text-right font-bold text-slate-800">
                        {m ? m.name : "—"}
                        {m?.price ? <span className="ml-1 font-normal text-slate-500">{m.price}円</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ================= 時間割 ================= */

type Faculty = { id: number; name: string };
type Dept = { id: number; faculty_id: number; name: string };
type Cat = { id: number; name: string };
type Act = { id: number; category_id: number | null; name: string };

type ClassRow = {
  id: number;
  starts_at: string;
  ends_at: string;
  teacher: string;
  changed: boolean;
  change_note: string;
  rooms: { building_code: string; code: string; name: string } | null;
  courses: { name: string; class_name: string; teacher: string } | null;
};

type ActRow = {
  id: number;
  starts_at: string;
  ends_at: string;
  title: string;
  rooms: { building_code: string; code: string; name: string } | null;
};

function Timetable({ date, periods }: { date: Date; periods: Period[] }) {
  // null = 未選択、数字 = その限、"act" = 課外活動
  const [sel, setSel] = useState<number | "act" | null>(null);

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">何限を見ますか</p>
      <div className="grid grid-cols-3 gap-1.5">
        {periods.map((p) => (
          <button
            key={p.id}
            onClick={() => setSel(p.id)}
            className={`rounded-xl py-2 text-xs font-bold transition active:scale-95 ${
              sel === p.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {p.label}
            <span className="mt-0.5 block text-[9px] font-normal opacity-70">
              {hhmm(p.starts_at)}
            </span>
          </button>
        ))}
      </div>

      {/* 課外活動は授業と選び方が違うので、離して別の見た目にする */}
      <button
        onClick={() => setSel("act")}
        className={`mt-1.5 w-full rounded-xl border-2 border-dashed py-2.5 text-xs font-bold transition active:scale-95 ${
          sel === "act"
            ? "border-violet-500 bg-violet-500 text-white"
            : "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100"
        }`}
      >
        課外活動
      </button>

      <div className="mt-3">
        {sel === null && <Note>時限を選んでください。</Note>}
        {typeof sel === "number" && <ByDepartment date={date} periodId={sel} />}
        {sel === "act" && <ByActivity date={date} />}
      </div>
    </div>
  );
}

/** 学科を選び、その学科の授業を出す */
function ByDepartment({ date, periodId }: { date: Date; periodId: number }) {
  const [facs, setFacs] = useState<Faculty[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [dept, setDept] = useState<Dept | null>(null);
  const [rows, setRows] = useState<ClassRow[] | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = createClient();
      const [f, d] = await Promise.all([
        supabase.from("faculties").select("id, name").order("sort_order"),
        supabase.from("departments").select("id, faculty_id, name").order("sort_order"),
      ]);
      setFacs((f.data as Faculty[]) ?? []);
      setDepts((d.data as Dept[]) ?? []);
    })();
  }, []);

  // 限か日か学科が変わったら取り直す
  useEffect(() => {
    if (!dept) {
      setRows(null);
      return;
    }
    void (async () => {
      const { data } = await createClient()
        .from("timetable")
        .select(
          "id, starts_at, ends_at, teacher, changed, change_note, rooms(building_code, code, name), courses!inner(name, class_name, teacher, department_id)",
        )
        .eq("on_date", ymd(date))
        .eq("period_id", periodId)
        .eq("kind", "class")
        .eq("courses.department_id", dept.id);
      setRows((data as unknown as ClassRow[]) ?? []);
    })();
  }, [dept, date, periodId]);

  if (dept) {
    return (
      <div>
        <button
          onClick={() => setDept(null)}
          className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"
        >
          ← 学科を選び直す
        </button>
        <p className="mb-1.5 text-xs font-bold text-slate-900">{dept.name}</p>
        {rows === null ? (
          <Note>読み込み中…</Note>
        ) : rows.length === 0 ? (
          <Note>この時限に登録された授業はありません。</Note>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl bg-slate-50 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-bold text-slate-900">
                    {r.courses?.name ?? "（科目名なし）"}
                  </span>
                  {r.changed && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                      変更あり
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-600">
                  {r.courses?.class_name && <span>クラス {r.courses.class_name}</span>}
                  <span>{r.courses?.teacher || r.teacher || "担当未定"}</span>
                </div>
                <div className="mt-1 text-[11px] font-bold text-slate-700">
                  {r.rooms ? `${r.rooms.building_code}号館 ${r.rooms.code}` : "教室未定"}
                  <span className="ml-2 font-normal text-slate-500">
                    {hhmm(r.starts_at)}〜{hhmm(r.ends_at)}
                  </span>
                </div>
                {r.change_note && (
                  <p className="mt-1 text-[10px] text-amber-700">{r.change_note}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">学科を選んでください</p>
      <div className="flex flex-col gap-2">
        {facs.map((f) => {
          const list = depts.filter((d) => d.faculty_id === f.id);
          if (list.length === 0) return null;
          return (
            <div key={f.id}>
              <div className="mb-1 text-[10px] font-bold text-slate-400">{f.name}</div>
              <div className="flex flex-col gap-1">
                {list.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setDept(d)}
                    className="rounded-lg bg-slate-100 px-3 py-2 text-left text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {facs.length === 0 && <Note>学科がまだ登録されていません。</Note>}
      </div>
    </div>
  );
}

/** 系統を選び、団体を選び、その日の予定を出す */
function ByActivity({ date }: { date: Date }) {
  const [cats, setCats] = useState<Cat[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [cat, setCat] = useState<Cat | null>(null);
  const [act, setAct] = useState<Act | null>(null);
  const [rows, setRows] = useState<ActRow[] | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = createClient();
      const [c, a] = await Promise.all([
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);
      setCats((c.data as Cat[]) ?? []);
      setActs((a.data as Act[]) ?? []);
    })();
  }, []);

  useEffect(() => {
    if (!act) {
      setRows(null);
      return;
    }
    void (async () => {
      const { data } = await createClient()
        .from("timetable")
        .select("id, starts_at, ends_at, title, rooms(building_code, code, name)")
        .eq("on_date", ymd(date))
        .eq("kind", "activity")
        .eq("activity_id", act.id)
        .order("starts_at");
      setRows((data as unknown as ActRow[]) ?? []);
    })();
  }, [act, date]);

  if (act) {
    return (
      <div>
        <button
          onClick={() => setAct(null)}
          className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"
        >
          ← 団体を選び直す
        </button>
        <p className="mb-1.5 text-xs font-bold text-slate-900">{act.name}</p>
        {rows === null ? (
          <Note>読み込み中…</Note>
        ) : rows.length === 0 ? (
          <div className="rounded-xl bg-slate-50 p-4 text-center">
            <p className="text-sm font-bold text-slate-700">なし</p>
            <p className="mt-0.5 text-[10px] text-slate-500">この日の活動予定はありません</p>
          </div>
        ) : (
          <>
            {rows.length > 1 && (
              <p className="mb-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-[10px] font-bold text-violet-700">
                複数教室（{rows.length}か所）で活動します
              </p>
            )}
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li key={r.id} className="rounded-xl bg-slate-50 p-2.5">
                  <div className="text-sm font-bold text-slate-900">
                    {hhmm(r.starts_at)}〜{hhmm(r.ends_at)}
                  </div>
                  <div className="mt-0.5 text-[11px] font-bold text-slate-700">
                    {r.rooms ? `${r.rooms.building_code}号館 ${r.rooms.code}` : "教室未定"}
                    {r.rooms?.name ? (
                      <span className="ml-1 font-normal text-slate-500">{r.rooms.name}</span>
                    ) : null}
                  </div>
                  {r.title && <p className="mt-0.5 text-[10px] text-slate-500">{r.title}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  if (cat) {
    const list = acts.filter((a) => a.category_id === cat.id);
    return (
      <div>
        <button
          onClick={() => setCat(null)}
          className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"
        >
          ← 系統を選び直す
        </button>
        <p className="mb-1.5 text-[11px] font-bold text-slate-500">{cat.name}</p>
        <div className="flex flex-col gap-1">
          {list.map((a) => (
            <button
              key={a.id}
              onClick={() => setAct(a)}
              className="rounded-lg bg-violet-50 px-3 py-2 text-left text-[11px] font-bold text-violet-800 transition hover:bg-violet-100 active:scale-95"
            >
              {a.name}
            </button>
          ))}
          {list.length === 0 && <Note>この系統の団体は登録されていません。</Note>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">何系の活動ですか</p>
      <div className="flex flex-col gap-1">
        {cats.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c)}
            className="rounded-lg bg-slate-100 px-3 py-2 text-left text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
          >
            {c.name}
          </button>
        ))}
        {cats.length === 0 && <Note>課外活動がまだ登録されていません。</Note>}
      </div>
    </div>
  );
}

/* ================= 空き教室 ================= */

type FreeRow = {
  room_id: number;
  building_code: string;
  room_code: string;
  room_name: string;
  floor: number;
  period_id: number;
  period_label: string;
};

function FreeRooms({ date, periods }: { date: Date; periods: Period[] }) {
  const [building, setBuilding] = useState("");
  const [periodId, setPeriodId] = useState<number | null>(null);
  const [all, setAll] = useState<FreeRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await createClient().rpc("free_rooms", { d: ymd(date) });
    setAll((data as FreeRow[]) ?? []);
    setLoading(false);
  }, [date]);

  // 日が変わったら取り直す
  useEffect(() => {
    setAll(null);
  }, [date]);

  const hits = useMemo(() => {
    if (!all || periodId === null) return null;
    const b = building.trim().replace(/号館$/, "");
    return all.filter(
      (r) => r.period_id === periodId && (b === "" || r.building_code === b),
    );
  }, [all, periodId, building]);

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">何号館を調べますか</p>
      <div className="flex items-center gap-1.5">
        <input
          value={building}
          onChange={(e) => setBuilding(e.target.value)}
          inputMode="numeric"
          placeholder="23"
          className="w-20 rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-xs font-bold text-slate-500">号館</span>
        <span className="ml-auto text-[10px] text-slate-400">空欄なら全体</span>
      </div>

      <p className="mb-1.5 mt-3 text-[11px] font-bold text-slate-500">時限</p>
      <div className="grid grid-cols-3 gap-1.5">
        {periods.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setPeriodId(p.id);
              if (!all) void load();
            }}
            className={`rounded-xl py-2 text-xs font-bold transition active:scale-95 ${
              periodId === p.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {periodId === null ? (
          <Note>時限を選んでください。</Note>
        ) : loading || hits === null ? (
          <Note>読み込み中…</Note>
        ) : hits.length === 0 ? (
          <Note>空いている教室はありません。</Note>
        ) : (
          <>
            <p className="mb-1.5 text-[11px] font-bold text-slate-500">
              {hits.length} 室が空いています
            </p>
            <ul className="flex flex-col gap-1">
              {hits.map((r) => (
                <li
                  key={r.room_id}
                  className="flex items-baseline justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2"
                >
                  <span className="text-xs font-bold text-emerald-900">
                    {r.building_code}号館 {r.room_code}
                  </span>
                  <span className="min-w-0 truncate text-[10px] text-emerald-700">
                    {r.room_name}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 共通 ================= */

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500">
      {children}
    </p>
  );
}

function Big({
  onClick,
  icon,
  label,
  sub,
}: {
  onClick: () => void;
  icon: string;
  label: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl bg-slate-100 px-3 py-3 text-left transition hover:bg-slate-200 active:scale-95"
    >
      <span className="text-lg">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-slate-800">{label}</span>
        <span className="block text-[10px] text-slate-500">{sub}</span>
      </span>
    </button>
  );
}
