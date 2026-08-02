-- KIT map — 食堂・時間割・空き教室
--
-- Supabase の SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルで決めること
--   1. 食堂  … 提供口の「開いているか」と、枠に入る「品名」を分けて持つ
--   2. 時間割 … 授業と課外活動を一つの表に入れ、
--                同じ教室の同じ時間に二つ入らないようにする
--   3. 空き教室 … 上の表から「使われていない」を引き算して出す


-- ===============================================================
-- 0. 重なりを禁じるために使う拡張
--
--    「同じ教室で時間が重なる予定は入れられない」を
--    データベース自身に守らせる。btree_gist が要る
-- ===============================================================

create extension if not exists btree_gist;


-- ===============================================================
-- 1. 食堂の品目
--
--    ■ 二種類あるので、木にして親子で持つ
--
--    提供口（親）… 開いているかどうかだけを日々書く
--      KITランチ / ラーメン / うどん・そば / カレー / 丼もの
--
--    枠（子）    … その日の品名を書く
--      日替わりランチ / 特麺 / 日替わり丼 / 週替わり丼 / 特丼
--
--    親子を一つの表にしたのは、並び順や食堂の付け替えを
--    二か所に書かなくて済むようにするため。
-- ===============================================================

create table if not exists public.cafeteria_items (
  id           bigint generated always as identity primary key,
  cafeteria_id smallint not null references public.cafeterias on delete cascade,
  -- counter … 提供口そのもの。開閉を書く
  -- slot    … 提供口にぶら下がる枠。品名を書く
  kind         text not null check (kind in ('counter','slot')),
  -- slot のときだけ、どの提供口の中かを指す
  parent_id    bigint references public.cafeteria_items on delete cascade,
  name         text not null,
  sort_order   smallint not null default 0,

  -- 提供口に親はいない。枠には必ず親がいる
  check (
    (kind = 'counter' and parent_id is null) or
    (kind = 'slot'    and parent_id is not null)
  ),
  -- 同じ食堂に同じ名前を二つ作らせない
  unique (cafeteria_id, name),
  -- 下の表から「これは提供口／これは枠」と指定して繋ぐために要る
  unique (id, kind)
);

create index if not exists cafeteria_items_parent_idx
  on public.cafeteria_items (parent_id);


-- ---------------------------------------------------------------
-- 1-a. 提供口の、その日の状態
-- ---------------------------------------------------------------

create table if not exists public.counter_days (
  id         bigint generated always as identity primary key,
  item_id    bigint not null,
  -- 繋ぎ先が必ず「提供口」であることを、この列と外部キーで縛る。
  -- 枠（slot）の行をここへ入れようとすると外部キーで弾かれる
  item_kind  text not null default 'counter' check (item_kind = 'counter'),
  on_date    date not null,
  -- open    … 活動中
  -- closed  … 活動休止
  -- soldout … 売り切れ
  state      text not null check (state in ('open','closed','soldout')),
  note       text not null default '',
  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now(),

  foreign key (item_id, item_kind)
    references public.cafeteria_items (id, kind) on delete cascade,
  -- 同じ提供口の同じ日は一行だけ
  unique (item_id, on_date)
);

create index if not exists counter_days_date_idx on public.counter_days (on_date);


-- ---------------------------------------------------------------
-- 1-b. 枠の、その日の品名
-- ---------------------------------------------------------------

create table if not exists public.menu_days (
  id         bigint generated always as identity primary key,
  item_id    bigint not null,
  -- こちらは必ず「枠」であることを縛る
  item_kind  text not null default 'slot' check (item_kind = 'slot'),
  on_date    date not null,
  name       text not null,              -- "味噌カツ丼"
  price      int,
  note       text not null default '',
  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now(),

  foreign key (item_id, item_kind)
    references public.cafeteria_items (id, kind) on delete cascade,
  -- 同じ枠の同じ日は一行だけ
  unique (item_id, on_date)
);

create index if not exists menu_days_date_idx on public.menu_days (on_date);


-- ---------------------------------------------------------------
-- 1-c. 初期データ
--
--    ★ 特丼 は、どの提供口の下かの指定が無かったため
--      丼もの の下に置いた。違っていれば下の一行で移せる：
--        update public.cafeteria_items
--        set parent_id = (select id from public.cafeteria_items where name = 'ラーメン')
--        where name = '特丼';
-- ---------------------------------------------------------------

insert into public.cafeterias (name, note)
select '学生食堂', ''
where not exists (select 1 from public.cafeterias);

-- 提供口
insert into public.cafeteria_items (cafeteria_id, kind, parent_id, name, sort_order)
select c.id, 'counter', null, v.name, v.ord
from public.cafeterias c
cross join (values
  ('KITランチ',    1),
  ('ラーメン',      2),
  ('うどん・そば',  3),
  ('カレー',        4),
  ('丼もの',        5)
) as v(name, ord)
where c.id = (select min(id) from public.cafeterias)
on conflict (cafeteria_id, name) do nothing;

-- 枠。親の名前で結び付ける
insert into public.cafeteria_items (cafeteria_id, kind, parent_id, name, sort_order)
select p.cafeteria_id, 'slot', p.id, v.name, v.ord
from (values
  ('KITランチ', '日替わりランチ', 1),
  ('ラーメン',  '特麺',           1),
  ('丼もの',    '日替わり丼',     1),
  ('丼もの',    '週替わり丼',     2),
  ('丼もの',    '特丼',           3)
) as v(parent, name, ord)
join public.cafeteria_items p
  on p.name = v.parent and p.kind = 'counter'
on conflict (cafeteria_id, name) do nothing;


-- ===============================================================
-- 2. 課外活動の団体
--
--    はじめ projects という名前で作っていたので、
--    もう作ってしまっている場合は名前を付け替える。
--    どちらの状態から実行しても同じ形になる。
-- ===============================================================

do $rename$
declare
  n_act int := 0;
  n_tt  int := 0;
begin
  if to_regclass('public.projects') is null then
    return;                       -- 前の版を実行していない。何もしない
  end if;

  execute 'select count(*) from public.projects' into n_act;
  if to_regclass('public.timetable') is not null then
    execute 'select count(*) from public.timetable' into n_tt;
  end if;

  -- 中身が無ければ作り直す。列名も check の中身も一度に正しくなる
  if n_act = 0 and n_tt = 0 then
    drop table if exists public.timetable cascade;
    drop table if exists public.projects  cascade;
    raise notice '前の版の projects / timetable を作り直しました';
  else
    raise exception
      '前の版の projects(%行) か timetable(%行) に中身があります。'
      '移し終えてから、この二つを削除して実行し直してください', n_act, n_tt;
  end if;
end $rename$;

create table if not exists public.club_activities (
  id     bigint generated always as identity primary key,
  name   text not null unique,
  leader text not null default '',
  note   text not null default ''
);


-- ===============================================================
-- 3. 時間割（授業と課外活動）
--
--    ■ なぜ一つの表にまとめたか
--
--    「同じ時間に授業と課外活動を被らせない」を守るには、
--    両方が同じ表に入っている必要がある。別々の表に分けると、
--    データベースには二つをまたいで重なりを禁じる手立てが無く、
--    画面側の確認だけが頼りになる。人の書き方や通信の行き違いで
--    すり抜けるので、ここでは物理的に入らないようにしている。
-- ===============================================================

create table if not exists public.timetable (
  id          bigint generated always as identity primary key,
  on_date     date not null,
  room_id     bigint not null references public.rooms on delete cascade,

  -- class   … 授業
  -- activity … 課外活動
  kind        text not null check (kind in ('class','activity')),
  course_id   bigint references public.courses  on delete cascade,
  activity_id  bigint references public.club_activities on delete cascade,

  -- 授業は限で入れる。課外活動は限に収まらないことがあるので任意
  period_id   smallint references public.periods,
  -- 実際の時刻。限だけ入れた場合は下の仕掛けが periods から埋める
  starts_at   time not null,
  ends_at     time not null,

  -- その日の担当者。代わりの先生が来た日もここに書く
  teacher     text not null default '',
  title       text not null default '',   -- 活動名や補足

  -- いつもと違う日はここに印を付ける
  changed     boolean not null default false,
  change_note text not null default '',   -- "教室変更" "休講" "補講"

  created_by  uuid references auth.users on delete set null,
  created_at  timestamptz not null default now(),

  -- 種類に合ったものを指しているか
  check (
    (kind = 'class'   and course_id  is not null and activity_id is null) or
    (kind = 'activity' and activity_id is not null and course_id  is null)
  ),
  check (ends_at > starts_at),

  -- ★同じ教室で時間が少しでも重なる予定は入れられない。
  --   授業どうし・活動どうしだけでなく、授業と活動の間にも効く
  exclude using gist (
    room_id with =,
    tsrange(on_date + starts_at, on_date + ends_at, '[)') with &&
  )
);

create index if not exists timetable_date_idx on public.timetable (on_date);
create index if not exists timetable_room_idx on public.timetable (room_id);

-- 限だけ書いて時刻を省いたときに、periods から時刻を埋める
create or replace function public.fill_period_time()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.period_id is not null then
    if new.starts_at is null then
      select starts_at into new.starts_at from public.periods where id = new.period_id;
    end if;
    if new.ends_at is null then
      select ends_at into new.ends_at from public.periods where id = new.period_id;
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_fill_period_time on public.timetable;
create trigger trg_fill_period_time
  before insert or update on public.timetable
  for each row execute function public.fill_period_time();

-- 時刻の列は not null のままでよい。
-- 「入っているか」の確認は before の仕掛けが動いたあとに行われるので、
-- 限だけ書いて時刻を省いても通る。どちらも書かなければ、その場で弾かれる。


-- ===============================================================
-- 4. 毎週の時間割から、日ごとの行を作る
--
--    class_sessions（毎週このコマ）を、指定した期間の日付に広げる。
--    まず普段どおりを作り、変わった日だけ後から直して
--    changed に印を付ける、という使い方を想定している。
--
--    すでに入っている日は触らない（手で直した内容を消さない）。
-- ===============================================================

create or replace function public.fill_timetable(
  from_date date,
  to_date   date,
  in_term   text
) returns int
language plpgsql security invoker set search_path = public as $$
declare
  made int := 0;
begin
  insert into public.timetable
    (on_date, room_id, kind, course_id, period_id, starts_at, ends_at, teacher, created_by)
  select d::date, s.room_id, 'class', s.course_id, s.period_id,
         p.starts_at, p.ends_at, coalesce(c.teacher, ''), auth.uid()
  from generate_series(from_date, to_date, interval '1 day') as d
  join public.class_sessions s
    on s.term = in_term
   and s.weekday = extract(dow from d)::smallint
  join public.periods p on p.id = s.period_id
  join public.courses c on c.id = s.course_id
  -- 同じ教室の同じ時間に何か入っていれば作らない
  where not exists (
    select 1 from public.timetable t
    where t.room_id = s.room_id
      and t.on_date = d::date
      and tsrange(t.on_date + t.starts_at, t.on_date + t.ends_at, '[)')
          && tsrange(d::date + p.starts_at, d::date + p.ends_at, '[)')
  );

  get diagnostics made = row_count;
  return made;
end; $$;


-- ===============================================================
-- 5. 空き教室
--
--    時間割に何も入っていない教室を、限ごとに返す。
--    security invoker なので、呼んだ人の権限で見える範囲しか返らない。
--
--    使い方（画面側）：
--      supabase.rpc('free_rooms', { d: '2026-08-05' })
-- ===============================================================

create or replace function public.free_rooms(d date)
returns table (
  room_id       bigint,
  building_code text,
  room_code     text,
  room_name     text,
  floor         smallint,
  period_id     smallint,
  period_label  text
)
language sql stable security invoker set search_path = public as $$
  select r.id, r.building_code, r.code, r.name, r.floor, p.id, p.label
  from public.rooms r
  cross join public.periods p
  -- 教室として使える部屋だけ。事務室や設備は数えない
  where r.category in ('class','lab')
    and not exists (
      select 1 from public.timetable t
      where t.room_id = r.id
        and t.on_date = d
        and tsrange(t.on_date + t.starts_at, t.on_date + t.ends_at, '[)')
            && tsrange(d + p.starts_at, d + p.ends_at, '[)')
    )
  order by r.building_code, r.code, p.id;
$$;


-- ===============================================================
-- 6. アクセス制御
--
--    読めるのは承認された人だけ（rank >= 1）。
--    書き込みは中身によって分ける。
-- ===============================================================

alter table public.cafeteria_items enable row level security;
alter table public.counter_days    enable row level security;
alter table public.menu_days       enable row level security;
alter table public.club_activities        enable row level security;
alter table public.timetable       enable row level security;

drop policy if exists "items read"    on public.cafeteria_items;
drop policy if exists "items write"   on public.cafeteria_items;
drop policy if exists "counter read"  on public.counter_days;
drop policy if exists "counter write" on public.counter_days;
drop policy if exists "menu read"     on public.menu_days;
drop policy if exists "menu write"    on public.menu_days;
drop policy if exists "activities read"  on public.club_activities;
drop policy if exists "activities write" on public.club_activities;
drop policy if exists "tt read"       on public.timetable;
drop policy if exists "tt insert"     on public.timetable;
drop policy if exists "tt update"     on public.timetable;
drop policy if exists "tt delete"     on public.timetable;

create policy "items read"   on public.cafeteria_items for select using (public.role_rank() >= 1);
create policy "counter read" on public.counter_days    for select using (public.role_rank() >= 1);
create policy "menu read"    on public.menu_days       for select using (public.role_rank() >= 1);
create policy "activities read" on public.club_activities       for select using (public.role_rank() >= 1);
create policy "tt read"      on public.timetable       for select using (public.role_rank() >= 1);

-- 食堂は Lv3 が管理する
create policy "items write"   on public.cafeteria_items
  for all using (public.role_rank() >= 4) with check (public.role_rank() >= 4);
create policy "counter write" on public.counter_days
  for all using (public.role_rank() >= 4) with check (public.role_rank() >= 4);
create policy "menu write"    on public.menu_days
  for all using (public.role_rank() >= 4) with check (public.role_rank() >= 4);

-- 団体の登録は Lv2 以上
create policy "activities write" on public.club_activities
  for all using (public.role_rank() >= 3) with check (public.role_rank() >= 3);

-- 授業は Lv2 以上、課外活動は Lv1 以上
create policy "tt insert" on public.timetable
  for insert with check (
    (kind = 'class'   and public.role_rank() >= 3) or
    (kind = 'activity' and public.role_rank() >= 2)
  );

-- 自分が入れたものは自分で直せる。Lv3 は全部直せる
create policy "tt update" on public.timetable
  for update using (created_by = auth.uid() or public.role_rank() >= 4);
create policy "tt delete" on public.timetable
  for delete using (created_by = auth.uid() or public.role_rank() >= 4);


-- ===============================================================
-- 7. 古い表について
--
--    reservations（教室の予約）は timetable と役割が重なる。
--    教室が空いているかの判断は timetable だけを見るようにしたので、
--    予約も timetable に kind='activity' で入れるのがよい。
--
--    中身を移し終えたら、次の一行で消せる：
--      drop table if exists public.reservations;
--
--    class_sessions（毎週の時間割）は残す。
--    fill_timetable がここから日ごとの行を作るため。
-- ===============================================================
