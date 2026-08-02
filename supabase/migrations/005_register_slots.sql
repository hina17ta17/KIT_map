-- KIT map — 予定をまとめて登録する
--
-- Supabase の SQL Editor に貼って実行する。004 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ なぜ要るか
--   号館ごと、あるいは全号館を選べるようにすると、一度に千を超える
--   教室へ入れることになる。教室ごとに呼び出すと往復が千回を超え、
--   待たされるうえ、途中で通信が切れると半端な状態が残る。
--   ここでまとめて受け取り、中で順に入れて、結果だけを返す。


create or replace function public.register_slots(
  p_kind        text,
  p_room_ids    bigint[],
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
language plpgsql security definer set search_path = public as $slots$
declare
  rid        bigint;
  res        jsonb;
  registered jsonb := '[]'::jsonb;
  blocked    jsonb := '[]'::jsonb;
  confirm    jsonb := '[]'::jsonb;
  removed    int   := 0;
begin
  if p_room_ids is null or array_length(p_room_ids, 1) is null then
    raise exception '教室が選ばれていません';
  end if;

  -- 一度に入れられる数の上限。押し間違いで全学に入れてしまうのを防ぐ
  if array_length(p_room_ids, 1) > 2000 then
    raise exception '一度に登録できるのは2000室までです';
  end if;

  foreach rid in array p_room_ids loop
    -- 判断はすべて register_slot に任せる。
    -- 優先順位も、消したときの知らせも、あちらに一本化してある
    res := public.register_slot(
      p_kind, rid, p_date, p_period_id, p_starts, p_ends,
      p_course_id, p_activity_id, p_title, p_teacher, p_force);

    if (res->>'ok')::boolean then
      registered := registered || jsonb_build_object('room_id', rid);
      removed := removed + coalesce(jsonb_array_length(res->'removed'), 0);
    elsif res->>'reason' = 'blocked' then
      blocked := blocked || jsonb_build_object('room_id', rid, 'blocked_by', res->'blocked_by');
    else
      confirm := confirm || jsonb_build_object('room_id', rid, 'will_remove', res->'will_remove');
    end if;
  end loop;

  return jsonb_build_object(
    'registered', registered,
    'blocked',    blocked,
    'confirm',    confirm,
    'removed',    removed
  );
end $slots$;

comment on function public.register_slots is
  '予定をまとめて入れる。判断は register_slot と同じで、'
  '入った教室・入れなかった教室・確認が要る教室に分けて返す。';


-- ===============================================================
-- 確かめ方
-- ===============================================================
-- select public.register_slots('activity', array[1,2,3]::bigint[], '2026-08-05',
--          null, '18:00'::time, '20:00'::time, null, 1, '練習', '', false);
