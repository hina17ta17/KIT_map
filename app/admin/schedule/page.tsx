"use client";

/**
 * 予定の登録（授業・イベント・課外活動）。
 *
 * 入れるのは register_slot だけ。画面から直接 timetable へは書かない。
 * 優先順位（授業 > イベント > 課外活動）の判断と、弱い予定の削除、
 * 消された人への知らせを一つの処理としてまとめてあるため。
 *
 * 授業がすでに入っている時間には、イベントも課外活動も入れられない。
 * その判断もデータベース側で行う。画面だけで止めると、
 * 同時に操作されたときにすり抜ける。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { type Role } from "@/lib/auth";

type Kind = "class" | "event" | "activity";

type Period = { id: number; label: string; starts_at: string; ends_at: string };
type Room = { id: number; building_code: string; code: string; name: string };
type Faculty = { id: number; name: string };
type Dept = { id: number; faculty_id: number; name: string };
type Course = { id: number; name: string; class_name: string; teacher: string };
type Cat = { id: number; name: string };
type Act = { id: number; category_id: number | null; name: string };

/** register_slot の返り値 */
type SlotResult =
  | { ok: true; id: number; removed: Conflict[] }
  | { ok: false; reason: "blocked"; blocked_by: Conflict[] }
  | { ok: false; reason: "confirm"; will_remove: Conflict[] };

type Conflict = {
  id: number;
  kind: Kind;
  title: string;
  starts_at: string;
  ends_at: string;
};

const KIND_LABEL: Record<Kind, string> = {
  class: "授業",
  event: "イベント",
  activity: "課外活動",
};

/** 表が無いときの Postgres の返し方。まだ SQL を流していないと起きる */
function isMissingTable(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === "42P01" || /does not exist|schema cache/i.test(e.message ?? "");
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(t: string): string {
  const [h, m] = t.split(":");
  return `${h}:${m}`;
}

export default function SchedulePage() {
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  /** SQL がまだ流されていない場合に、何を実行すべきかを出す */
  const [setupNeeded, setSetupNeeded] = useState<string | null>(null);

  const [kind, setKind] = useState<Kind>("class");
  const [date, setDate] = useState(today());

  const [periods, setPeriods] = useState<Period[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [facs, setFacs] = useState<Faculty[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);

  /* 入力 */
  const [buildingCode, setBuildingCode] = useState("");
  const [roomId, setRoomId] = useState<number | null>(null);
  const [periodId, setPeriodId] = useState<number | null>(null);
  const [deptId, setDeptId] = useState<number | null>(null);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [courseName, setCourseName] = useState("");
  const [className, setClassName] = useState("");
  const [teacher, setTeacher] = useState("");
  const [catId, setCatId] = useState<number | null>(null);
  const [activityId, setActivityId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState("18:00");
  const [endAt, setEndAt] = useState("20:00");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  /** 消してよいか尋ねている最中の相手 */
  const [confirming, setConfirming] = useState<Conflict[] | null>(null);

  /* ---------------- 読み込み ---------------- */

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
      setEmail(u.user.email ?? "");
      setTeacher(u.user.email ?? "");

      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", u.user.id)
        .single();
      setRole((me?.role as Role) ?? null);

      const [p, r, f, d, c, a] = await Promise.all([
        supabase.from("periods").select("id, label, starts_at, ends_at").order("id"),
        supabase.from("rooms").select("id, building_code, code, name").order("building_code").order("code"),
        supabase.from("faculties").select("id, name").order("sort_order"),
        supabase.from("departments").select("id, faculty_id, name").order("sort_order"),
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);

      setPeriods((p.data as Period[]) ?? []);
      setRooms((r.data as Room[]) ?? []);
      setFacs((f.data as Faculty[]) ?? []);
      setDepts((d.data as Dept[]) ?? []);
      setCats((c.data as Cat[]) ?? []);
      setActs((a.data as Act[]) ?? []);

      const missing: string[] = [];
      if (isMissingTable(f.error) || isMissingTable(d.error)) missing.push("003_departments_activities.sql");
      if (isMissingTable(c.error) || isMissingTable(a.error)) missing.push("002_cafeteria_timetable.sql / 003");
      if (missing.length) setSetupNeeded([...new Set(missing)].join(" と "));

      setLoading(false);
    })();
  }, []);

  /* 学科を選んだら、その学科の科目を読む */
  useEffect(() => {
    if (deptId === null) {
      setCourses([]);
      return;
    }
    void createClient()
      .from("courses")
      .select("id, name, class_name, teacher")
      .eq("department_id", deptId)
      .order("name")
      .then(({ data }) => setCourses((data as Course[]) ?? []));
  }, [deptId]);

  const roomsInBuilding = useMemo(() => {
    const b = buildingCode.trim().replace(/号館$/, "");
    if (!b) return [];
    return rooms.filter((r) => r.building_code === b);
  }, [rooms, buildingCode]);

  const room = useMemo(() => rooms.find((r) => r.id === roomId) ?? null, [rooms, roomId]);
  const actsInCat = useMemo(
    () => (catId === null ? [] : acts.filter((a) => a.category_id === catId)),
    [acts, catId],
  );

  /* ---------------- 登録 ---------------- */

  const submit = useCallback(
    async (force: boolean) => {
      setMsg(null);
      const supabase = createClient();

      if (!roomId) {
        setMsg({ kind: "err", text: "教室を選んでください" });
        return;
      }

      setBusy(true);
      try {
        let useCourseId = courseId;

        // 授業で、まだ無い科目なら先に作る
        if (kind === "class" && !useCourseId) {
          if (!courseName.trim()) {
            setMsg({ kind: "err", text: "授業名を入れてください" });
            return;
          }
          if (deptId === null) {
            setMsg({ kind: "err", text: "学科を選んでください" });
            return;
          }
          const { data, error } = await supabase
            .from("courses")
            .insert({
              name: courseName.trim(),
              class_name: className.trim(),
              teacher: teacher.trim(),
              department_id: deptId,
            })
            .select("id")
            .single();
          if (error) throw error;
          useCourseId = (data as { id: number }).id;
        }

        if (kind === "class" && periodId === null) {
          setMsg({ kind: "err", text: "時限を選んでください" });
          return;
        }
        if (kind === "activity" && activityId === null) {
          setMsg({ kind: "err", text: "団体を選んでください" });
          return;
        }
        if (kind === "event" && !title.trim()) {
          setMsg({ kind: "err", text: "イベント名を入れてください" });
          return;
        }

        const { data, error } = await supabase.rpc("register_slot", {
          p_kind: kind,
          p_room_id: roomId,
          p_date: date,
          p_period_id: kind === "class" ? periodId : null,
          p_starts: kind === "class" ? null : startAt,
          p_ends: kind === "class" ? null : endAt,
          p_course_id: kind === "class" ? useCourseId : null,
          p_activity_id: kind === "activity" ? activityId : null,
          p_title: kind === "event" ? title.trim() : title.trim(),
          p_teacher: teacher.trim(),
          p_force: force,
        });
        if (error) throw error;

        const res = data as SlotResult;

        if (res.ok) {
          setConfirming(null);
          const removed = res.removed?.length ?? 0;
          setMsg({
            kind: "ok",
            text:
              `登録しました。` +
              (removed > 0 ? `重なっていた予定 ${removed} 件を取り消し、登録者に知らせました。` : ""),
          });
          return;
        }

        if (res.reason === "blocked") {
          const names = res.blocked_by
            .map((b) => `${KIND_LABEL[b.kind]}「${b.title || "（名称なし）"}」${hhmm(b.starts_at)}〜${hhmm(b.ends_at)}`)
            .join(" / ");
          const hasClass = res.blocked_by.some((b) => b.kind === "class");
          setConfirming(null);
          setMsg({
            kind: "err",
            text: hasClass
              ? `授業があります。この時間には登録できません。（${names}）`
              : `すでに予定が入っています。先に入れたものが優先されます。（${names}）`,
          });
          return;
        }

        // 弱い予定がある。消してよいか尋ねる
        setConfirming(res.will_remove);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        setMsg({
          kind: "err",
          text: isMissingTable(err)
            ? "データベースの更新がまだです。SQL を実行してください。"
            : (err.message ?? "登録できませんでした"),
        });
      } finally {
        setBusy(false);
      }
    },
    [kind, roomId, date, periodId, courseId, courseName, className, teacher, deptId, activityId, title, startAt, endAt],
  );

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">サーバーに接続できません。</p></Shell>;

  if (!role)
    return (
      <Shell>
        <p className="text-sm text-slate-700">ログインしていません。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          ログインへ
        </Link>
      </Shell>
    );

  // 課外活動とイベントは Lv1 以上、授業は Lv2 以上
  const canEvent = role === "admin_l1" || role === "admin_l2" || role === "admin_l3";
  const canClass = role === "admin_l2" || role === "admin_l3";

  if (!canEvent)
    return (
      <Shell>
        <p className="text-sm text-slate-700">この画面は管理者Lv1以上が使えます。</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">地図へ戻る</Link>
      </Shell>
    );

  return (
    <Shell wide>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-900">予定の登録</h1>
        <div className="flex gap-3 text-xs font-semibold text-slate-500">
          <Link href="/admin" className="hover:text-slate-800">承認</Link>
          <Link href="/admin/rooms" className="hover:text-slate-800">教室</Link>
          <Link href="/" className="hover:text-slate-800">地図</Link>
        </div>
      </div>

      {setupNeeded && (
        <div className="mb-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <b>データベースの更新がまだです。</b>
          <br />
          Supabase の SQL Editor で <code className="font-mono">{setupNeeded}</code> を実行してください。
          学科や課外活動の一覧は、それまで空のままになります。
        </div>
      )}

      {/* 何を登録するか */}
      <div className="mb-3 grid grid-cols-3 gap-1.5">
        {(["class", "event", "activity"] as const).map((k) => {
          const disabled = k === "class" && !canClass;
          return (
            <button
              key={k}
              disabled={disabled}
              onClick={() => {
                setKind(k);
                setMsg(null);
                setConfirming(null);
              }}
              className={`rounded-xl py-2.5 text-sm font-bold transition ${
                kind === k
                  ? "bg-slate-900 text-white"
                  : disabled
                    ? "bg-slate-50 text-slate-300"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {KIND_LABEL[k]}
              {disabled && <span className="mt-0.5 block text-[9px] font-normal">Lv2以上</span>}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        <Field label="日付">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
          />
        </Field>

        {/* ---- 教室 ---- */}
        <Field label="教室">
          <div className="flex items-center gap-2">
            <input
              value={buildingCode}
              onChange={(e) => {
                setBuildingCode(e.target.value);
                setRoomId(null);
              }}
              inputMode="numeric"
              placeholder="23"
              className="w-20 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-bold outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs font-bold text-slate-500">号館</span>
            <select
              value={roomId ?? ""}
              onChange={(e) => setRoomId(e.target.value ? Number(e.target.value) : null)}
              className="min-w-0 flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            >
              <option value="">教室番号を選ぶ</option>
              {roomsInBuilding.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code}
                </option>
              ))}
            </select>
          </div>
          {buildingCode && roomsInBuilding.length === 0 && (
            <p className="mt-1 text-[10px] text-amber-700">
              この号館の教室が登録されていません
            </p>
          )}
          {room && (
            <p className="mt-1 text-[11px] font-bold text-slate-700">
              部屋名：{room.name || "（未登録）"}
            </p>
          )}
        </Field>

        {/* ---- 授業 ---- */}
        {kind === "class" && (
          <>
            <Field label="時限">
              <div className="grid grid-cols-5 gap-1.5">
                {periods.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPeriodId(p.id)}
                    className={`rounded-xl py-2 text-xs font-bold transition ${
                      periodId === p.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {p.label}
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">
                      {hhmm(p.starts_at)}
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            <Field label="どの学科の授業か">
              <select
                value={deptId ?? ""}
                onChange={(e) => {
                  setDeptId(e.target.value ? Number(e.target.value) : null);
                  setCourseId(null);
                }}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              >
                <option value="">学科を選ぶ</option>
                {facs.map((f) => (
                  <optgroup key={f.id} label={f.name}>
                    {depts
                      .filter((d) => d.faculty_id === f.id)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              {facs.length === 0 && (
                <p className="mt-1 text-[10px] text-amber-700">
                  学科がまだ登録されていません（003 の SQL を実行してください）
                </p>
              )}
            </Field>

            <Field label="授業名">
              <select
                value={courseId ?? ""}
                onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              >
                <option value="">新しく登録する</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.class_name ? `（${c.class_name}）` : ""}
                  </option>
                ))}
              </select>
              {courseId === null && (
                <div className="mt-1.5 flex gap-2">
                  <input
                    value={courseName}
                    onChange={(e) => setCourseName(e.target.value)}
                    placeholder="授業名"
                    className="min-w-0 flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    value={className}
                    onChange={(e) => setClassName(e.target.value)}
                    placeholder="クラス"
                    className="w-24 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
            </Field>

            <Field label="登録者・担当">
              <input
                value={teacher}
                onChange={(e) => setTeacher(e.target.value)}
                placeholder="担当の先生"
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-[10px] text-slate-400">
                登録した人（{email}）は自動で記録されます
              </p>
            </Field>
          </>
        )}

        {/* ---- イベント・課外活動 ---- */}
        {kind !== "class" && (
          <>
            <Field label="何時から何時まで">
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  className="flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-xs font-bold text-slate-500">〜</span>
                <input
                  type="time"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  className="flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </Field>

            {kind === "activity" && (
              <Field label="団体">
                <select
                  value={catId ?? ""}
                  onChange={(e) => {
                    setCatId(e.target.value ? Number(e.target.value) : null);
                    setActivityId(null);
                  }}
                  className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">系統を選ぶ</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {catId !== null && (
                  <select
                    value={activityId ?? ""}
                    onChange={(e) => setActivityId(e.target.value ? Number(e.target.value) : null)}
                    className="mt-1.5 w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">団体を選ぶ</option>
                    {actsInCat.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                {cats.length === 0 && (
                  <p className="mt-1 text-[10px] text-amber-700">
                    課外活動がまだ登録されていません（003 の SQL を実行してください）
                  </p>
                )}
              </Field>
            )}

            <Field label={kind === "event" ? "イベント名" : "活動の内容（任意）"}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === "event" ? "オープンキャンパス" : "練習・打ち合わせ など"}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              />
            </Field>
          </>
        )}

        {/* ---- 確認 ---- */}
        {confirming && (
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xs font-bold text-amber-900">
              この時間には、すでに次の予定が入っています。
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {confirming.map((c) => (
                <li key={c.id} className="text-[11px] text-amber-800">
                  ・{KIND_LABEL[c.kind]}「{c.title || "（名称なし）"}」{hhmm(c.starts_at)}〜{hhmm(c.ends_at)}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">
              {KIND_LABEL[kind]}を登録すると、上の予定は取り消されます。
              登録した人には知らせが届きます。よろしいですか？
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void submit(true)}
                disabled={busy}
                className="flex-1 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-amber-700 disabled:bg-slate-300"
              >
                はい、取り消して登録する
              </button>
              <button
                onClick={() => setConfirming(null)}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-600 shadow-sm"
              >
                やめる
              </button>
            </div>
          </div>
        )}

        {msg && (
          <p
            className={`rounded-xl p-3 text-xs leading-relaxed ${
              msg.kind === "ok"
                ? "bg-emerald-50 text-emerald-900"
                : msg.kind === "warn"
                  ? "bg-amber-50 text-amber-900"
                  : "bg-red-50 text-red-800"
            }`}
          >
            {msg.text}
          </p>
        )}

        {!confirming && (
          <button
            onClick={() => void submit(false)}
            disabled={busy}
            className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
          >
            {busy ? "登録中…" : `${KIND_LABEL[kind]}を登録する`}
          </button>
        )}

        <p className="border-t border-slate-100 pt-3 text-[10px] leading-relaxed text-slate-400">
          優先順位は 授業 ＞ イベント ＞ 課外活動。
          同じ強さどうしは、先に入れたものが残ります。
          授業が入っている時間には、イベントも課外活動も登録できません。
        </p>
      </div>
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-bold text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-[100dvh] bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-lg" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
