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
/** code は学科のクラス記号（機械工学科なら KM）。006 を流す前は空 */
type Dept = { id: number; faculty_id: number; name: string; code?: string };
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

/** register_slots（まとめて登録）の返り値 */
type BatchResult = {
  registered: { room_id: number }[];
  blocked: { room_id: number; blocked_by: Conflict[] }[];
  confirm: { room_id: number; will_remove: Conflict[] }[];
  removed: number;
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
  /** SQL をまだ流していないか。表が無いことで見分ける */
  const [setupNeeded, setSetupNeeded] = useState(false);

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
  /** 見ている号館。号館ごと、あるいは全号館を選べる */
  const [buildingCodes, setBuildingCodes] = useState<string[]>([]);
  /** 選んだ教室。まとめて同じ予定を入れられるよう複数持つ */
  const [roomIds, setRoomIds] = useState<number[]>([]);
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
  /** 消してよいか尋ねている最中の教室と、その相手 */
  const [pending, setPending] = useState<{ room: Room; conflicts: Conflict[] }[] | null>(null);

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
        // 記号の列がまだ無い場合もあるので、列を並べずにまとめて取る
        supabase.from("departments").select("*").order("sort_order"),
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);

      setPeriods((p.data as Period[]) ?? []);
      setRooms((r.data as Room[]) ?? []);
      setFacs((f.data as Faculty[]) ?? []);
      setDepts((d.data as Dept[]) ?? []);
      setCats((c.data as Cat[]) ?? []);
      setActs((a.data as Act[]) ?? []);

      // 表そのものが無い＝まだ SQL を流していない。
      // どれか一つでも無ければ同じことなので、まとめて一度だけ知らせる
      setSetupNeeded(
        [f.error, d.error, c.error, a.error].some((e) => isMissingTable(e)),
      );

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

  /** 教室が登録されている号館。番号の小さい順に並べる */
  const allBuildings = useMemo(() => {
    const s = [...new Set(rooms.map((r) => r.building_code).filter(Boolean))];
    return s.sort((a, b) => (Number(a) || 9999) - (Number(b) || 9999) || a.localeCompare(b, "ja"));
  }, [rooms]);

  /** いま選んでいる号館にある教室 */
  const roomsInScope = useMemo(
    () => (buildingCodes.length === 0 ? [] : rooms.filter((r) => buildingCodes.includes(r.building_code))),
    [rooms, buildingCodes],
  );

  const chosen = useMemo(
    () => roomIds.map((id) => rooms.find((r) => r.id === id)).filter((r): r is Room => !!r),
    [rooms, roomIds],
  );
  const actsInCat = useMemo(
    () => (catId === null ? [] : acts.filter((a) => a.category_id === catId)),
    [acts, catId],
  );
  /** 選んだ学科のクラス記号。クラス欄の書き方を示すのに使う */
  const deptCode = useMemo(
    () => depts.find((d) => d.id === deptId)?.code ?? "",
    [depts, deptId],
  );

  /* ---------------- 登録 ---------------- */

  /**
   * 選んだ教室ぶん、順に登録する。
   *
   * targets を渡すと、その教室だけを対象にする。
   * 「消してよいか」を尋ねたあとは、すでに入った教室をもう一度なぞらないよう、
   * 尋ねた相手だけを渡し直す。
   */
  const submit = useCallback(
    async (force: boolean, targets?: Room[]) => {
      setMsg(null);
      const supabase = createClient();
      const list = targets ?? chosen;

      if (list.length === 0) {
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

        // 教室ごとに呼ぶと、全号館では千回を超える往復になる。
        // まとめて渡し、向こうで順に入れてもらう
        const { data, error } = await supabase.rpc("register_slots", {
          p_kind: kind,
          p_room_ids: list.map((r) => r.id),
          p_date: date,
          p_period_id: kind === "class" ? periodId : null,
          p_starts: kind === "class" ? null : startAt,
          p_ends: kind === "class" ? null : endAt,
          p_course_id: kind === "class" ? useCourseId : null,
          p_activity_id: kind === "activity" ? activityId : null,
          p_title: title.trim(),
          p_teacher: teacher.trim(),
          p_force: force,
        });
        if (error) throw error;

        const res = data as BatchResult;
        const byId = new Map(list.map((r) => [r.id, r]));
        const where = (id: number) => {
          const r = byId.get(id);
          return r ? `${r.code}` : `教室${id}`;
        };

        const done = res.registered.length;
        const removed = res.removed;
        const blockedByClass: string[] = [];
        const blockedOther: string[] = [];

        for (const b of res.blocked) {
          const names = b.blocked_by
            .map((x) => `${KIND_LABEL[x.kind]}「${x.title || "（名称なし）"}」`)
            .join("・");
          if (b.blocked_by.some((x) => x.kind === "class"))
            blockedByClass.push(`${where(b.room_id)}（${names}）`);
          else blockedOther.push(`${where(b.room_id)}（${names}）`);
        }

        // 尋ねる相手が残っていれば、そこで一度止める
        const ask = res.confirm
          .map((c) => ({ room: byId.get(c.room_id), conflicts: c.will_remove }))
          .filter((x): x is { room: Room; conflicts: Conflict[] } => !!x.room);

        if (ask.length > 0) {
          setPending(ask);
          if (done > 0) {
            setMsg({ kind: "warn", text: `${done}室に登録しました。残りは確認が必要です。` });
          }
          return;
        }

        setPending(null);

        const parts: string[] = [];
        if (done > 0) parts.push(`${done}室に登録しました。`);
        if (removed > 0) parts.push(`重なっていた予定 ${removed} 件を取り消し、登録者に知らせました。`);
        if (blockedByClass.length > 0)
          parts.push(`授業があるため登録できませんでした：${blockedByClass.join(" / ")}`);
        if (blockedOther.length > 0)
          parts.push(`すでに予定があり、先に入れたものが優先されます：${blockedOther.join(" / ")}`);

        setMsg({
          kind: done > 0 ? (blockedByClass.length || blockedOther.length ? "warn" : "ok") : "err",
          text: parts.join(" "),
        });
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
    [kind, chosen, date, periodId, courseId, courseName, className, teacher, deptId, activityId, title, startAt, endAt],
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
          <b>データベースの準備がまだ終わっていません。</b>
          <br />
          学科・課外活動・イベントの表がまだ作られていないため、下の一覧は空のままです。
          <br />
          Supabase の SQL Editor で <code className="font-mono">supabase/setup.sql</code>{" "}
          を貼り付けて実行すると、必要なものが一度にそろいます。
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
                setPending(null);
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

        {/* ---- 教室。まとめて同じ予定を入れられるよう、いくつでも選べる ---- */}
        <Field label="教室（号館ごと・全号館も選べます）">
          {/* 号館を選ぶ。番号を打たなくても押すだけで選べるようにする */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-slate-500">号館</span>
            <span className="text-[11px] font-bold text-slate-600">
              {roomIds.length > 0 ? `${roomIds.length}室を選択中` : "未選択"}
            </span>
          </div>

          <div className="mt-1 flex gap-1.5">
            <button
              onClick={() => setBuildingCodes(allBuildings)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition ${
                buildingCodes.length === allBuildings.length && allBuildings.length > 0
                  ? "bg-slate-900 text-white"
                  : "bg-slate-200 text-slate-700 hover:bg-slate-300"
              }`}
            >
              すべての号館（{allBuildings.length}棟・{rooms.length}室）
            </button>
            <button
              onClick={() => {
                setBuildingCodes([]);
                setRoomIds([]);
              }}
              className="rounded-lg bg-white px-2 py-1.5 text-[11px] font-bold text-slate-500 shadow-sm transition hover:bg-slate-100"
            >
              解除
            </button>
          </div>

          <div className="mt-1.5 flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-xl bg-slate-50 p-1.5">
            {allBuildings.map((b) => {
              const on = buildingCodes.includes(b);
              return (
                <button
                  key={b}
                  onClick={() =>
                    setBuildingCodes((prev) =>
                      on ? prev.filter((x) => x !== b) : [...prev, b],
                    )
                  }
                  className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                    on ? "bg-blue-600 text-white" : "bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                  }`}
                >
                  {b}
                </button>
              );
            })}
            {allBuildings.length === 0 && (
              <span className="p-1 text-[10px] text-amber-700">教室が登録されていません</span>
            )}
          </div>

          {roomsInScope.length > 0 && (
            <>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={() => setRoomIds(roomsInScope.map((r) => r.id))}
                  className="flex-1 rounded-lg bg-slate-200 px-2 py-1.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-300"
                >
                  選んだ号館の教室をすべて選ぶ（{roomsInScope.length}室）
                </button>
                <button
                  onClick={() => setRoomIds([])}
                  className="rounded-lg bg-white px-2 py-1.5 text-[11px] font-bold text-slate-500 shadow-sm transition hover:bg-slate-100"
                >
                  全部外す
                </button>
              </div>

              {/* 全号館だと千を超えるので、並べるのは先頭だけにする。
                  「すべて選ぶ」は並べていない分も含める */}
              <ul className="mt-1.5 max-h-52 overflow-y-auto rounded-xl bg-slate-50 p-1.5">
                {roomsInScope.slice(0, 300).map((r) => {
                  const on = roomIds.includes(r.id);
                  return (
                    <li key={r.id}>
                      <button
                        onClick={() =>
                          setRoomIds((prev) =>
                            on ? prev.filter((x) => x !== r.id) : [...prev, r.id],
                          )
                        }
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                          on ? "bg-blue-600 text-white" : "hover:bg-white"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${
                            on ? "bg-white text-blue-600" : "bg-white text-transparent ring-1 ring-slate-300"
                          }`}
                        >
                          ✓
                        </span>
                        {buildingCodes.length > 1 && (
                          <span
                            className={`w-10 shrink-0 text-[10px] ${on ? "text-blue-100" : "text-slate-400"}`}
                          >
                            {r.building_code}号
                          </span>
                        )}
                        <span className="w-14 shrink-0 text-xs font-bold">{r.code}</span>
                        <span
                          className={`min-w-0 truncate text-[11px] ${on ? "text-blue-100" : "text-slate-500"}`}
                        >
                          {r.name || "（部屋名なし）"}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {roomsInScope.length > 300 && (
                  <li className="px-2 py-1.5 text-[10px] text-slate-500">
                    ほか {roomsInScope.length - 300} 室（「すべて選ぶ」にはこれらも含まれます）
                  </li>
                )}
              </ul>
            </>
          )}

          {chosen.length > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
              <b>選択中：</b>
              {chosen
                .slice(0, 12)
                .map((r) => `${r.code}`)
                .join(" ／ ")}
              {chosen.length > 12 && ` ほか ${chosen.length - 12} 室`}
            </p>
          )}

          {chosen.length >= 100 && (
            <p className="mt-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-800">
              {chosen.length}室にまとめて登録します。数が多いので、日付と時間を確かめてください。
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
              {/* 準備が済んでいないときは上の帯で伝えているので、ここでは繰り返さない */}
              {!setupNeeded && facs.length === 0 && (
                <p className="mt-1 text-[10px] text-amber-700">学科が登録されていません</p>
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
                    placeholder={deptCode ? `${deptCode}1` : "クラス"}
                    className="w-24 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
              {courseId === null && (
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                  クラスは、同じ科目を分けて受ける組のこと。
                  {deptCode
                    ? `この学科の記号は ${deptCode} なので、${deptCode}1・${deptCode}2 のように書きます。`
                    : "KM1・CC2 のように、学科の記号と組の番号で書きます。"}
                  分かれていなければ空のままで構いません。
                </p>
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
                {!setupNeeded && cats.length === 0 && (
                  <p className="mt-1 text-[10px] text-amber-700">課外活動が登録されていません</p>
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

        {/* ---- 確認。教室ごとに、何が消えるのかを並べて一度だけ尋ねる ---- */}
        {pending && (
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xs font-bold text-amber-900">
              次の{pending.length}室には、すでに予定が入っています。
            </p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {pending.map(({ room: rm, conflicts }) => (
                <li key={rm.id} className="text-[11px] text-amber-800">
                  <b>{rm.code}</b>
                  <ul className="mt-0.5 pl-3">
                    {conflicts.map((c) => (
                      <li key={c.id}>
                        ・{KIND_LABEL[c.kind]}「{c.title || "（名称なし）"}」{hhmm(c.starts_at)}〜
                        {hhmm(c.ends_at)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">
              {KIND_LABEL[kind]}を登録すると、上の予定は取り消されます。
              登録した人には知らせが届きます。よろしいですか？
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void submit(true, pending.map((p) => p.room))}
                disabled={busy}
                className="flex-1 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-amber-700 disabled:bg-slate-300"
              >
                はい、取り消して登録する
              </button>
              <button
                onClick={() => setPending(null)}
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

        {!pending && (
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
    // 本文は地図のために overflow-hidden。ここで送れるようにする
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-lg" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
