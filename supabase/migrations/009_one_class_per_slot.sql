-- KIT map — 一つの教室の一つの限には一つだけ
--
-- Supabase の SQL Editor に貼って実行する。008 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルですること
--   1. 重なっている予定が残っていれば、先に入れたほうを残して片づける
--   2. 重なりを禁じる決まりが無ければ付け直す
--
-- ■ 補足
--   この決まりは 002 で作った時点から効いている。
--   確かめたところ、同じ教室・同じ限に別の科目を入れようとすると
--   23P01（exclusion constraint）で弾かれる。
--   ここは「万一この決まりが外れていた場合」に備えた念のための手当て。
--   すでに正しく入っていれば、何も起きずに終わる。


-- ===============================================================
-- 1. 重なっているものを片づける
--
--    先に入れたものを残す。created_at が同じなら id の小さいほう。
--    決まりを付け直す前に片づけないと、付け直すこと自体が失敗する。
-- ===============================================================

do $tidy$
declare
  n int := 0;
begin
  with ranked as (
    select
      a.id,
      row_number() over (
        partition by a.room_id, a.on_date
        order by a.created_at, a.id
      ) as seq,
      a.created_at,
      a.starts_at,
      a.ends_at,
      a.room_id,
      a.on_date
    from public.timetable a
  ),
  -- 自分より先に入っていて、時間が重なっているものがあれば、自分は消す
  losers as (
    select r.id
    from ranked r
    where exists (
      select 1 from ranked w
      where w.room_id = r.room_id
        and w.on_date = r.on_date
        and w.seq < r.seq
        and tsrange(w.on_date + w.starts_at, w.on_date + w.ends_at, '[)')
         && tsrange(r.on_date + r.starts_at, r.on_date + r.ends_at, '[)')
    )
  )
  delete from public.timetable t using losers l where t.id = l.id;

  get diagnostics n = row_count;
  if n > 0 then
    raise notice '重なっていた予定を % 件片づけました（先に入れたほうを残しました）', n;
  else
    raise notice '重なっている予定はありませんでした';
  end if;
end $tidy$;


-- ===============================================================
-- 2. 重なりを禁じる決まりを確かめ、無ければ付ける
--
--    名前は作られ方によって変わるので、名前ではなく
--    「この表に排他制約（contype='x'）があるか」で見る。
-- ===============================================================

do $guard$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.timetable'::regclass
      and contype = 'x'
  ) then
    alter table public.timetable
      add constraint timetable_room_slot_excl
      exclude using gist (
        room_id with =,
        tsrange(on_date + starts_at, on_date + ends_at, '[)') with &&
      );
    raise notice '重なりを禁じる決まりを付けました';
  else
    raise notice '重なりを禁じる決まりはすでに入っています';
  end if;
end $guard$;


-- ===============================================================
-- 3. 確かめ方
-- ===============================================================
-- select conname, contype from pg_constraint
-- where conrelid = 'public.timetable'::regclass and contype = 'x';
--   → 1行返れば、重なりは入らない
--
-- 重なりが残っていないか
-- select a.id, b.id from public.timetable a join public.timetable b
--   on a.room_id = b.room_id and a.on_date = b.on_date and a.id < b.id
--  and tsrange(a.on_date + a.starts_at, a.on_date + a.ends_at, '[)')
--   && tsrange(b.on_date + b.starts_at, b.on_date + b.ends_at, '[)');
--   → 0行なら片づいている
