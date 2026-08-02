-- KIT map — データベース定義
--
-- Supabase の SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- ■ 方針：変わらないものはファイル、変わるものだけデータベース
--
--   ファイル（public/data/）… 敷地・建物・チェックポイント・接続
--     地図の形は滅多に変わらず、ログインも不要。
--     CDNから配れるので速く、無料枠も消費しない。
--
--   データベース（ここ）    … 利用者・教室・食堂メニュー・授業予定・予約
--     日々変わるもの、書き込みに権限がいるもの。
--
--   教室（rooms）だけは「誰でも読める」。
--   経路案内はログイン不要で使えるようにしており、
--   案内の最後に「302 は 3階です」を出すのに必要なため。
--
--   建物との結び付けは buildings.geojson の tempId（"B-04"）で行う。


-- ===============================================================
-- 1. 利用者と権限
-- ===============================================================

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text not null,
  -- pending  : 申請しただけ。何も見られない
  -- student  : 学内情報の閲覧
  -- admin_l1 : ＋ 放課後の教室予約
  -- admin_l2 : ＋ 授業の教室予約（l1 を含む）
  -- admin_l3 : ＋ 承認・昇格・降格、食堂メニューの登録
  role        text not null default 'pending'
              check (role in ('pending','student','admin_l1','admin_l2','admin_l3')),
  approved_by uuid references auth.users on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 新規登録したら自動で「承認待ち」の行を作る
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ===============================================================
-- 2. 権限を判定する関数
--    RLS の中から profiles を直接読むと再帰するため、
--    security definer で RLS を迂回して読む
-- ===============================================================

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- 権限の強さ。上位は下位を含む
create or replace function public.role_rank()
returns int language sql stable security definer set search_path = public as $$
  select case public.my_role()
    when 'admin_l3' then 4
    when 'admin_l2' then 3
    when 'admin_l1' then 2
    when 'student'  then 1
    else 0
  end;
$$;


-- ===============================================================
-- 3. 利用者のアクセス制御
-- ===============================================================

drop policy if exists "read own"    on public.profiles;
drop policy if exists "l3 read all" on public.profiles;
drop policy if exists "l3 update"   on public.profiles;

-- 自分の承認状態を知るため、自分の行だけは読める
create policy "read own" on public.profiles
  for select using (id = auth.uid());

-- Lv3 は承認画面のため全員分を読める
create policy "l3 read all" on public.profiles
  for select using (public.my_role() = 'admin_l3');

create policy "l3 update" on public.profiles
  for update using (public.my_role() = 'admin_l3');

-- Lv3 が 0 人になると誰も承認できず、システムが永久にロックする
create or replace function public.protect_last_l3()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin_l3' and new.role <> 'admin_l3' then
    if old.id = auth.uid() then
      raise exception '自分自身は降格できません';
    end if;
    if (select count(*) from public.profiles where role = 'admin_l3') <= 1 then
      raise exception '最後のLv3は降格できません';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_protect_last_l3 on public.profiles;
create trigger trg_protect_last_l3
  before update on public.profiles
  for each row execute function public.protect_last_l3();


-- ===============================================================
-- 4. 時限（1限は何時から何時まで）
--    空き教室の判定に使う。大学の実際の時間割に合わせて直す
-- ===============================================================

create table if not exists public.periods (
  id        smallint primary key,      -- 1限なら 1
  label     text not null,             -- "1限"
  starts_at time not null,
  ends_at   time not null
);

alter table public.periods enable row level security;

insert into public.periods (id, label, starts_at, ends_at) values
  (1, '1限', '09:00', '10:30'),
  (2, '2限', '10:40', '12:10'),
  (3, '3限', '13:00', '14:30'),
  (4, '4限', '14:40', '16:10'),
  (5, '5限', '16:20', '17:50')
on conflict (id) do nothing;

drop policy if exists "periods read"  on public.periods;
drop policy if exists "periods write" on public.periods;

create policy "periods read"  on public.periods for select using (public.role_rank() >= 1);
create policy "periods write" on public.periods for all    using (public.role_rank() >= 4);


-- ===============================================================
-- 5. 教室
--    「何号館の何階の何番の教室は何という名前か」を持つ
--
--    ★ここだけ誰でも読める。
--      経路案内はログイン不要で使えるようにしており、
--      案内の最後に「302 は 3階です」を出すのに必要なため。
--      部屋番号と階は秘密の情報ではない。書き込みだけ制限する。
-- ===============================================================

create table if not exists public.rooms (
  id            bigint generated always as identity primary key,
  -- buildings.geojson の tempId。地図の建物と結び付ける鍵
  building_id   text not null,              -- "B-04"
  -- 表示用の号館番号。地図データが無くても人が読める
  building_code text not null default '',   -- "23"
  -- 階。地下は負の数（B1 = -1）。0 は未確認
  floor         smallint not null default 0,
  code          text not null,              -- "302"
  name          text not null default '',   -- "情報演習室"
  category      text not null default 'class'
                check (category in ('class','lab','office','facility','other')),
  capacity      int,
  -- 「南口から入って正面の階段」など、案内の最後に添える一言
  hint          text not null default '',
  note          text not null default '',
  updated_by    uuid references auth.users on delete set null,
  updated_at    timestamptz not null default now(),
  -- 同じ建物に同じ部屋番号を二重に作らせない
  unique (building_id, code)
);

create index if not exists rooms_building_idx on public.rooms (building_id);
create index if not exists rooms_code_idx     on public.rooms (code);

alter table public.rooms enable row level security;

drop policy if exists "rooms read"  on public.rooms;
drop policy if exists "rooms write" on public.rooms;

-- 誰でも読める（ログインしていなくても）
create policy "rooms read" on public.rooms
  for select using (true);

-- 登録・修正は Lv2 以上
create policy "rooms write" on public.rooms
  for all using (public.role_rank() >= 3) with check (public.role_rank() >= 3);


-- ===============================================================
-- 6. 食堂のメニュー
-- ===============================================================

create table if not exists public.cafeterias (
  id      smallint generated always as identity primary key,
  name    text not null,               -- "第1食堂"
  -- 建物と結び付けたい場合は buildings.geojson の tempId を入れる
  building_id text,
  note    text not null default ''
);

create table if not exists public.menus (
  id           bigint generated always as identity primary key,
  cafeteria_id smallint not null references public.cafeterias on delete cascade,
  served_on    date not null,          -- 提供日
  category     text not null default '', -- "定食" "麺" など
  name         text not null,
  price        int,
  note         text not null default '',
  created_by   uuid references auth.users on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists menus_served_on_idx on public.menus (served_on);

alter table public.cafeterias enable row level security;
alter table public.menus      enable row level security;

drop policy if exists "cafeterias read"  on public.cafeterias;
drop policy if exists "cafeterias write" on public.cafeterias;
drop policy if exists "menus read"       on public.menus;
drop policy if exists "menus write"      on public.menus;

-- 承認された人なら誰でも見られる
create policy "cafeterias read"  on public.cafeterias for select using (public.role_rank() >= 1);
create policy "menus read"       on public.menus      for select using (public.role_rank() >= 1);
-- 登録できるのは Lv3
create policy "cafeterias write" on public.cafeterias for all using (public.role_rank() >= 4);
create policy "menus write"      on public.menus      for all using (public.role_rank() >= 4);


-- ===============================================================
-- 7. 授業（時間割）
-- ===============================================================

create table if not exists public.courses (
  id      bigint generated always as identity primary key,
  code    text not null default '',    -- 科目コード
  name    text not null,
  teacher text not null default '',
  note    text not null default ''
);

create table if not exists public.class_sessions (
  id          bigint generated always as identity primary key,
  course_id   bigint not null references public.courses on delete cascade,
  -- 教室は rooms テーブルを指す
  room_id     bigint   not null references public.rooms on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6), -- 0=日
  period_id   smallint not null references public.periods,
  term        text     not null,       -- "2026-前期"
  note        text     not null default '',
  created_by  uuid references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  -- 同じ学期・同じ曜日時限に、同じ教室で二重に授業を入れさせない
  unique (term, weekday, period_id, room_id)
);

create index if not exists class_sessions_room_idx
  on public.class_sessions (room_id);

alter table public.courses        enable row level security;
alter table public.class_sessions enable row level security;

drop policy if exists "courses read"   on public.courses;
drop policy if exists "courses write"  on public.courses;
drop policy if exists "sessions read"  on public.class_sessions;
drop policy if exists "sessions write" on public.class_sessions;

create policy "courses read"   on public.courses        for select using (public.role_rank() >= 1);
create policy "sessions read"  on public.class_sessions for select using (public.role_rank() >= 1);
-- 授業の登録は Lv2 以上
create policy "courses write"  on public.courses        for all using (public.role_rank() >= 3);
create policy "sessions write" on public.class_sessions for all using (public.role_rank() >= 3);


-- ===============================================================
-- 8. 教室の予約
-- ===============================================================

create table if not exists public.reservations (
  id          bigint generated always as identity primary key,
  room_id     bigint   not null references public.rooms on delete cascade,
  on_date     date     not null,
  period_id   smallint not null references public.periods,
  -- afterschool : 放課後（Lv1以上）
  -- class       : 授業（Lv2以上）
  kind        text not null check (kind in ('afterschool','class')),
  title       text not null,
  created_by  uuid references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  -- ★二重予約をデータベース側で物理的に防ぐ
  unique (on_date, period_id, room_id)
);

create index if not exists reservations_date_idx on public.reservations (on_date);

alter table public.reservations enable row level security;

drop policy if exists "res read"   on public.reservations;
drop policy if exists "res insert" on public.reservations;
drop policy if exists "res update" on public.reservations;
drop policy if exists "res delete" on public.reservations;

create policy "res read" on public.reservations
  for select using (public.role_rank() >= 1);

-- 放課後は Lv1 以上、授業は Lv2 以上
create policy "res insert" on public.reservations
  for insert with check (
    (kind = 'afterschool' and public.role_rank() >= 2) or
    (kind = 'class'       and public.role_rank() >= 3)
  );

-- 自分の予約は自分で直せる。Lv3 は全部直せる
create policy "res update" on public.reservations
  for update using (created_by = auth.uid() or public.role_rank() >= 4);

create policy "res delete" on public.reservations
  for delete using (created_by = auth.uid() or public.role_rank() >= 4);


-- ===============================================================
-- 9. 最初のLv3を自分にする
--    ★ /login で申請したあとに、メールアドレスを書き換えて実行する
-- ===============================================================
-- update public.profiles
-- set role = 'admin_l3'
-- where email = 'ここに自分のメールアドレス';
