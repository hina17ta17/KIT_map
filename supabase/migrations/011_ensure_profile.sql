-- KIT map — 席はあるのに情報が無い人を、その場で作り直す
--
-- Supabase の SQL Editor に貼って実行する。010 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ なぜ要るか
--   利用者の情報は二か所に分かれている。
--     auth.users      … ログインの席（Supabase の領分）
--     public.profiles … 権限・氏名・学年など（このアプリの領分）
--
--   申請すると両方できるが、profiles の行だけを消すと
--   席は残ったまま中身が無い状態になる。その人はログインできるのに、
--   画面から見ると「誰でもない」扱いになり、承認画面にも出てこない。
--
--   毎回 SQL で直すのは現実的でないので、
--   画面を開いたときに自分の行が無ければ自分で作れるようにする。
--
-- ■ 安全にしていること
--   ・作れるのは自分の行だけ（auth.uid() のものに限る）
--   ・権限は既定の pending。ここから自分を昇格させることはできない
--   ・すでに行があれば何もしない


create or replace function public.ensure_profile()
returns void
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  mail  text;
  fname text;
begin
  if uid is null then
    return;                        -- ログインしていない。何もしない
  end if;

  if exists (select 1 from public.profiles where id = uid) then
    return;                        -- すでにある
  end if;

  select email, coalesce(raw_user_meta_data->>'full_name', '')
  into mail, fname
  from auth.users
  where id = uid;

  if mail is null then
    return;                        -- 席が見つからない
  end if;

  -- role は書かない。既定の pending が入る
  insert into public.profiles (id, email, full_name)
  values (uid, mail, fname)
  on conflict (id) do nothing;
end; $$;

comment on function public.ensure_profile is
  '自分の profiles 行が無ければ作る。作れるのは自分の行だけで、権限は pending。';


-- ===============================================================
-- いま席だけ残っている人も、まとめて作り直しておく
-- ===============================================================

do $repair$
declare
  n int;
begin
  insert into public.profiles (id, email, full_name)
  select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', '')
  from auth.users u
  left join public.profiles p on p.id = u.id
  where p.id is null and u.email is not null;

  get diagnostics n = row_count;
  raise notice '情報が無かった % 名を作り直しました', n;
end $repair$;


-- ===============================================================
-- 確かめ方
-- ===============================================================
-- select
--   (select count(*) from auth.users where email is not null) as ログインの席,
--   (select count(*) from public.profiles)                    as 情報のある人;
