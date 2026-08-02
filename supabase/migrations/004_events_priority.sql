-- KIT map — 時限の修正・イベント・登録の優先順位
--
-- Supabase の SQL Editor に貼って実行する。003 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルで決めること
--   1. 実際の時間割に合わせて時限の時刻を直す
--   2. 授業に「学科」と「クラス」を持たせる
--   3. イベントを足し、登録の優先順位を 授業 > イベント > 課外活動 にする
--   4. 取り消された人に知らせが届くようにする


-- ===============================================================
-- 1. 時限の時刻
-- ===============================================================

insert into public.periods (id, label, starts_at, ends_at) values
  (1, '1限', '08:40', '10:20'),
  (2, '2限', '10:35', '12:15'),
  (3, '3限', '13:15', '14:55'),
  (4, '4限', '15:10', '16:50'),
  (5, '5限', '17:05', '18:45')
on conflict (id) do update
  set label = excluded.label,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at;


-- ===============================================================
-- 2. 授業に学科とクラスを持たせる
--
--    時間割は「学科を選ぶ → その学科の授業が出る」形にするので、
--    どの学科の授業かを持っている必要がある。
-- ===============================================================

alter table public.courses
  add column if not exists department_id smallint
    references public.departments on delete set null;

-- "A" "B1" など、同じ科目の中の組
alter table public.courses
  add column if not exists class_name text not null default '';

create index if not exists courses_department_idx
  on public.courses (department_id);


-- ===============================================================
-- 3. イベントを入れられるようにする
--
--    check の名前は付け方によって変わるので、
--    今ある check をすべて外してから、必要なものを付け直す。
-- ===============================================================

do $fix$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.timetable'::regclass and contype = 'c'
  loop
    execute format('alter table public.timetable drop constraint %I', c.conname);
  end loop;
end $fix$;

alter table public.timetable
  add constraint timetable_kind_check
  check (kind in ('class','event','activity'));

-- 種類に合ったものを指しているか。イベントはどちらも指さない
alter table public.timetable
  add constraint timetable_ref_check check (
    (kind = 'class'    and course_id   is not null and activity_id is null) or
    (kind = 'event'    and course_id   is null     and activity_id is null) or
    (kind = 'activity' and activity_id is not null and course_id   is null)
  );

alter table public.timetable
  add constraint timetable_time_check check (ends_at > starts_at);


-- ===============================================================
-- 4. 優先順位
--
--    数が大きいほど強い。強いものは弱いものを退けられる。
--    同じ強さどうしは、先に入っているものが残る。
-- ===============================================================

create or replace function public.slot_priority(k text)
returns int language sql immutable as $$
  select case k
    when 'class'    then 3   -- 授業
    when 'event'    then 2   -- イベント
    when 'activity' then 1   -- 課外活動
    else 0
  end;
$$;


-- ===============================================================
-- 5. 知らせ
--
--    予定を消された人に、何が入って消えたのかを届ける。
-- ===============================================================

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  title      text not null,
  body       text not null default '',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notif read"   on public.notifications;
drop policy if exists "notif update" on public.notifications;

-- 自分あてのものだけ読める
create policy "notif read" on public.notifications
  for select using (user_id = auth.uid());

-- 既読にするのは自分だけ
create policy "notif update" on public.notifications
  for update using (user_id = auth.uid());


-- ===============================================================
-- 6. 予定の登録
--
--    ■ なぜ関数にしたか
--
--    「弱い予定を消してから入れる」を画面側で二度に分けて行うと、
--    その間に別の人が入れてしまうことがある。消したのに入れられない、
--    という半端な状態も起こる。ここでは一つの処理としてまとめ、
--    途中で失敗すれば何も起きなかったことになるようにしている。
--
--    ■ 返り値
--      { ok: true,  id: 123, removed: [...] }       … 入った
--      { ok: false, reason: 'blocked',  blocked_by: [...] }
--            … 同じか強い予定がある。入れられない
--      { ok: false, reason: 'confirm',  will_remove: [...] }
--            … 弱い予定がある。消してよいか尋ねる段階
--              p_force を true にして呼び直すと、消して入れる
-- ===============================================================

create or replace function public.register_slot(
  p_kind        text,
  p_room_id     bigint,
  p_date        date,
  p_period_id   smallint default null,
  p_starts      time     default null,
  p_ends        time     default null,
  p_course_id   bigint   default null,
  p_activity_id bigint   default null,
  p_title       text     default '',
  p_teacher     text     default '',
  p_force       boolean  default false
) returns jsonb
language plpgsql security definer set search_path = public as $slot$
declare
  v_start time := p_starts;
  v_end   time := p_ends;
  v_pri   int  := public.slot_priority(p_kind);
  v_rank  int  := public.role_rank();
  v_span  tsrange;
  v_blocked jsonb;
  v_kill    jsonb;
  v_id      bigint;
  v_what    text;
  v_room    text;
  r         record;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if v_pri = 0 then
    raise exception '種類が正しくありません';
  end if;

  -- 誰が入れられるか
  if p_kind = 'class' and v_rank < 3 then
    raise exception '授業を登録できるのは管理者Lv2以上です';
  end if;
  if p_kind in ('event','activity') and v_rank < 2 then
    raise exception 'この登録には管理者Lv1以上が必要です';
  end if;

  -- 限だけ渡された場合は時刻を引く
  if v_start is null or v_end is null then
    select starts_at, ends_at into v_start, v_end
    from public.periods where id = p_period_id;
  end if;
  if v_start is null or v_end is null then
    raise exception '時間が決まっていません';
  end if;
  if v_end <= v_start then
    raise exception '終わりの時刻が始まりより前です';
  end if;

  v_span := tsrange(p_date + v_start, p_date + v_end, '[)');

  -- ぶつかる予定のうち、同じか強いもの。あれば入れられない
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_blocked
  from (
    select t.id, t.kind, t.title, t.starts_at, t.ends_at
    from public.timetable t
    where t.room_id = p_room_id
      and t.on_date = p_date
      and tsrange(t.on_date + t.starts_at, t.on_date + t.ends_at, '[)') && v_span
      and public.slot_priority(t.kind) >= v_pri
  ) x;

  if jsonb_array_length(v_blocked) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'blocked_by', v_blocked);
  end if;

  -- ぶつかる予定のうち、弱いもの。消すことになる
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_kill
  from (
    select t.id, t.kind, t.title, t.starts_at, t.ends_at
    from public.timetable t
    where t.room_id = p_room_id
      and t.on_date = p_date
      and tsrange(t.on_date + t.starts_at, t.on_date + t.ends_at, '[)') && v_span
      and public.slot_priority(t.kind) < v_pri
  ) x;

  -- 消してよいかを一度尋ねる
  if jsonb_array_length(v_kill) > 0 and not p_force then
    return jsonb_build_object('ok', false, 'reason', 'confirm', 'will_remove', v_kill);
  end if;

  -- 知らせに書く「何が入ったか」
  if p_kind = 'class' then
    select coalesce(c.name, '授業') into v_what from public.courses c where c.id = p_course_id;
  elsif p_kind = 'event' then
    v_what := coalesce(nullif(p_title, ''), 'イベント');
  else
    select coalesce(a.name, '課外活動') into v_what
    from public.club_activities a where a.id = p_activity_id;
  end if;

  select coalesce(rm.building_code, '') || '号館 ' || rm.code into v_room
  from public.rooms rm where rm.id = p_room_id;

  -- 弱い予定を消し、入れた人に知らせる
  for r in
    select t.id, t.created_by, t.starts_at, t.ends_at
    from public.timetable t
    where t.room_id = p_room_id
      and t.on_date = p_date
      and tsrange(t.on_date + t.starts_at, t.on_date + t.ends_at, '[)') && v_span
      and public.slot_priority(t.kind) < v_pri
  loop
    if r.created_by is not null then
      insert into public.notifications (user_id, title, body)
      values (
        r.created_by,
        '予定が取り消されました',
        to_char(p_date, 'YYYY年MM月DD日') || ' ' ||
        to_char(r.starts_at, 'HH24:MI') || '〜' || to_char(r.ends_at, 'HH24:MI') || ' ' ||
        coalesce(v_room, '') || ' の予定は、' ||
        case p_kind when 'class' then '授業「' when 'event' then 'イベント「' else '「' end ||
        coalesce(v_what, '') || '」が入ったため取り消されました。'
      );
    end if;
    delete from public.timetable where id = r.id;
  end loop;

  insert into public.timetable
    (on_date, room_id, kind, course_id, activity_id, period_id,
     starts_at, ends_at, teacher, title, created_by)
  values
    (p_date, p_room_id, p_kind, p_course_id, p_activity_id, p_period_id,
     v_start, v_end, p_teacher, p_title, auth.uid())
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'removed', v_kill);
end $slot$;


-- ===============================================================
-- 7. 直接の書き込みは締める
--
--    優先順位の判断を素通りされないよう、入れるのは関数からだけにする。
--    消すのは、自分が入れたものと Lv3 のみ。
-- ===============================================================

drop policy if exists "tt insert" on public.timetable;

-- insert の許可を出さない＝ RLS により誰も直接は入れられない。
-- register_slot は security definer なので、この制限を通らずに入れられる。

comment on function public.register_slot is
  '予定を入れる。優先順位は 授業 > イベント > 課外活動。'
  '弱い予定は確認のうえ消し、入れた人に知らせる。';


-- ===============================================================
-- 8. 確かめ方
-- ===============================================================
-- select id, label, starts_at, ends_at from public.periods order by id;
--
-- 入れてみる（教室IDと日付は実際のものに変える）
-- select public.register_slot('activity', 1, '2026-08-05', 3::smallint,
--          null, null, null, 1, '', '', false);
