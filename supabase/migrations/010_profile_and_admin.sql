-- KIT map — 申請の情報・Lv3の締め・操作パスワード
--
-- Supabase の SQL Editor に貼って実行する。009 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルで決めること
--   1. 申請のときに集める情報（氏名・学年・クラス・組）
--   2. 管理者Lv3 は画面から付けられないようにする
--   3. 既存の人の権限を変えるときに要る「操作パスワード」


-- ===============================================================
-- 0. パスワードを安全にしまうための拡張
--
--    そのまま置くと、データベースを覗ける人に全部見える。
--    crypt() で戻せない形にしてからしまう。
-- ===============================================================

create extension if not exists pgcrypto;


-- ===============================================================
-- 1. 申請のときに集める情報
-- ===============================================================

alter table public.profiles add column if not exists full_name  text not null default '';
-- 学年 1〜4。0 は未記入
alter table public.profiles add column if not exists grade      smallint not null default 0;
-- クラス記号。departments.code と同じ並び（KM, CC, DM …）
alter table public.profiles add column if not exists class_code text not null default '';
-- 組 1〜7。0 は未記入
alter table public.profiles add column if not exists group_no   smallint not null default 0;
-- 本人確認（メール＋認証アプリ）が済んでいるか
alter table public.profiles add column if not exists verified   boolean not null default false;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_grade_check') then
    alter table public.profiles
      add constraint profiles_grade_check check (grade between 0 and 4);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_group_check') then
    alter table public.profiles
      add constraint profiles_group_check check (group_no between 0 and 7);
  end if;
end $c$;

create index if not exists profiles_group_idx
  on public.profiles (grade, class_code, group_no);

-- 申請の途中で入れた値を、あとから本人が直せるようにする。
-- 権限（role）は自分では触らせない
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());


-- ===============================================================
-- 2. 管理者Lv3 は画面から付けられないようにする
--
--    ■ なぜ
--    Lv3 は承認も降格もできる、いちばん強い権限。
--    画面から付けられると、Lv3 を乗っ取られた時点で全部を握られる。
--    データベースに直接つないだときだけ付けられるようにしておく。
--
--    ■ 見分け方
--    画面からの操作には必ずログインした人がいる（auth.uid() が入る）。
--    SQL Editor や秘密鍵からの操作には誰もいない（auth.uid() が null）。
--    それで見分ける。
-- ===============================================================

create or replace function public.guard_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 画面からの操作で Lv3 を付けようとしたら止める
  if new.role = 'admin_l3' and old.role is distinct from 'admin_l3' and auth.uid() is not null then
    raise exception '管理者Lv3 は画面からは付けられません。データベースから設定してください';
  end if;
  return new;
end; $$;

drop trigger if exists trg_guard_role_change on public.profiles;
create trigger trg_guard_role_change
  before update on public.profiles
  for each row execute function public.guard_role_change();


-- ===============================================================
-- 3. 操作パスワード
--
--    すでに承認した人の権限を変えるときに要る合言葉。
--    間違って一括で降格させるような事故を、ひと手間で防ぐ。
--
--    ★設定のしかた（この一行を書き換えて実行する）
--      select public.set_admin_password('ここに好きな文字列');
--
--    長さや文字の決まりは付けていない。好きに決めてよい。
-- ===============================================================

create table if not exists public.admin_secrets (
  id         smallint primary key default 1 check (id = 1),
  -- crypt() で戻せない形にしたもの。元の文字列は残らない
  password   text not null,
  updated_at timestamptz not null default now(),
  constraint only_one_row check (id = 1)
);

alter table public.admin_secrets enable row level security;
-- 誰にも読ませない。RLS の方針を1つも作らないので、
-- 画面からは（公開鍵でも）中身を取れない
drop policy if exists "secrets none" on public.admin_secrets;

/** 操作パスワードを決める。データベースから実行する */
create or replace function public.set_admin_password(p_new text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    raise exception 'この操作はデータベースから行ってください';
  end if;
  insert into public.admin_secrets (id, password, updated_at)
  values (1, crypt(p_new, gen_salt('bf')), now())
  on conflict (id) do update
    set password = excluded.password, updated_at = now();
end; $$;

/** 合っているかだけを返す。中身は返さない */
create or replace function public.check_admin_password(p_try text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v text;
begin
  select password into v from public.admin_secrets where id = 1;
  -- まだ決めていなければ、誰も通さない
  if v is null then return false; end if;
  return v = crypt(p_try, v);
end; $$;


-- ===============================================================
-- 4. 権限をまとめて変える
--
--    ■ なぜ関数にしたか
--    ・新規の申請者をまとめて承認したい
--    ・すでに承認した人を変えるときは合言葉を要る形にしたい
--    この二つを画面側で分けて書くと、片方だけ抜ける。ここで一本化する。
--
--    返り値：実際に変えた人数
-- ===============================================================

create or replace function public.set_roles(
  p_ids      uuid[],
  p_role     text,
  p_password text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  n_changed int := 0;
  n_existing int := 0;
begin
  if public.my_role() <> 'admin_l3' then
    raise exception '権限を変えられるのは管理者Lv3だけです';
  end if;
  if p_role = 'admin_l3' then
    raise exception '管理者Lv3 は画面からは付けられません。データベースから設定してください';
  end if;
  if p_role not in ('pending','student','admin_l0','admin_l1','admin_l2') then
    raise exception '権限の名前が正しくありません';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- 承認待ち以外＝すでに使っている人が混ざっていたら合言葉を要る
  select count(*) into n_existing
  from public.profiles
  where id = any(p_ids) and role <> 'pending';

  if n_existing > 0 and not public.check_admin_password(coalesce(p_password, '')) then
    raise exception 'すでに承認した人を変えるには、操作パスワードが要ります';
  end if;

  -- Lv3 は数の対象にしない。降格させると承認できる人が居なくなる
  update public.profiles
  set role = p_role
  where id = any(p_ids) and role <> 'admin_l3' and role <> p_role;

  get diagnostics n_changed = row_count;
  return n_changed;
end; $$;

comment on function public.set_roles is
  '権限をまとめて変える。Lv3は付けられない。'
  'すでに承認した人が混ざるときは操作パスワードが要る。';


-- ===============================================================
-- 5. 申請したときに、名前などを引き継ぐ
--
--    登録の時点で渡した値（raw_user_meta_data）を profiles に写す。
--    あとから本人が画面で直せるので、ここでは入っていれば入れるだけ。
-- ===============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end; $$;


-- ===============================================================
-- 6. 使い方
-- ===============================================================
-- ① 操作パスワードを決める（必ず最初に一度）
--    select public.set_admin_password('ここに好きな文字列');
--
-- ② 自分を管理者Lv3にする（画面からは付けられない）
--    update public.profiles set role = 'admin_l3' where email = 'ここにメール';
--
-- ③ 確かめる
--    select email, role, full_name, grade, class_code, group_no, verified
--    from public.profiles order by created_at;
