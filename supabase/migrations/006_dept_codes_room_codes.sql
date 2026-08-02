-- KIT map — 学科の記号と、教室番号の書き方
--
-- Supabase の SQL Editor に貼って実行する。005 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルで決めること
--   1. 学科ごとのクラス記号（機械工学科 = KM など）を持たせる
--   2. 教室番号に号館の番号を含める（220 ではなく 23-220 と書く）


-- ===============================================================
-- 1. 学科のクラス記号
-- ===============================================================

alter table public.departments
  add column if not exists code text not null default '';

update public.departments d
set code = v.code
from (values
  ('経営情報学科',             'DM'),
  ('環境デザイン創成学科',      'DE'),
  ('メディア情報学科',          'MM'),
  ('心理情報デザイン学科',      'MP'),
  ('情報工学科',               'CC'),
  ('知能情報システム学科',      'CA'),
  ('ロボティクス学科',          'CR'),
  ('環境・応用化学科',          'BE'),
  ('生命・応用バイオ学科',      'BS'),
  ('機械工学科',               'KM'),
  ('先進機械システム工学科',    'KS'),
  ('航空宇宙工学科',           'KA'),
  ('電気エネルギーシステム工学科','KE'),
  ('電子情報システム工学科',    'KI'),
  ('環境土木工学科',           'KC'),
  ('建築学科',                 'AE'),
  ('建築デザイン学科',          'AD')
) as v(name, code)
where d.name = v.name and d.code is distinct from v.code;

-- 記号は学科ごとに一つ。空のままの学科があってもよいので、
-- 入っているものだけを重複させない
create unique index if not exists departments_code_key
  on public.departments (code) where code <> '';


-- ===============================================================
-- 2. 教室番号に号館の番号を含める
--
--    ■ なぜ直すか
--    もとの一覧は「23-220」の形で書かれていたが、取り込むときに
--    号館の番号を切り離して「220」だけを残していた。
--    そのため画面では「23号館 220」と組み直して出しており、
--    もとの資料と見比べにくかった。番号をそのまま持たせる。
--
--    ■ 今ある二通りの書き方
--    (a) building_code='23', code='101'   … 1591室。号館の番号が無い
--    (b) building_code='',   code='6-141' … 91室。号館の番号が入っている
--    どちらも building_code='23', code='23-101' の形に揃える。
-- ===============================================================

-- 2-a. (b) の行は、番号の頭から号館の番号を取り出して埋める
update public.rooms
set building_code = split_part(code, '-', 1)
where building_code = ''
  and code like '%-%'
  and split_part(code, '-', 1) <> '';

-- 2-b. まだ号館の番号が付いていない行に付ける。
--      すでに付いている行は触らないので、何度実行してもよい
update public.rooms
set code = building_code || '-' || code
where building_code <> ''
  and code not like building_code || '-%';


-- ===============================================================
-- 3. 知らせの文面
--
--    教室番号がそれだけで号館まで表すようになったので、
--    「23号館 23-101」と重ねて書かないようにする。
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

  if p_kind = 'class' and v_rank < 3 then
    raise exception '授業を登録できるのは管理者Lv2以上です';
  end if;
  if p_kind in ('event','activity') and v_rank < 2 then
    raise exception 'この登録には管理者Lv1以上が必要です';
  end if;

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

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_kill
  from (
    select t.id, t.kind, t.title, t.starts_at, t.ends_at
    from public.timetable t
    where t.room_id = p_room_id
      and t.on_date = p_date
      and tsrange(t.on_date + t.starts_at, t.on_date + t.ends_at, '[)') && v_span
      and public.slot_priority(t.kind) < v_pri
  ) x;

  if jsonb_array_length(v_kill) > 0 and not p_force then
    return jsonb_build_object('ok', false, 'reason', 'confirm', 'will_remove', v_kill);
  end if;

  if p_kind = 'class' then
    select coalesce(c.name, '授業') into v_what from public.courses c where c.id = p_course_id;
  elsif p_kind = 'event' then
    v_what := coalesce(nullif(p_title, ''), 'イベント');
  else
    select coalesce(a.name, '課外活動') into v_what
    from public.club_activities a where a.id = p_activity_id;
  end if;

  -- 番号がそれだけで号館まで表すので、そのまま出す
  select rm.code into v_room from public.rooms rm where rm.id = p_room_id;

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
        '教室 ' || coalesce(v_room, '') || ' の予定は、' ||
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
-- 4. 確かめ方
-- ===============================================================
-- select name, code from public.departments order by sort_order;
--
-- select building_code, code, name from public.rooms
-- where building_code = '23' order by code limit 10;
--   → 23 / 23-101 / 学生ステーション のように出れば直っている
--
-- select count(*) from public.rooms where code not like building_code || '-%';
--   → 0 になっていれば全部そろっている
