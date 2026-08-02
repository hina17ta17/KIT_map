-- KIT map — まとめて実行する用の SQL
--
-- ■ 使い方
--   Supabase の SQL Editor に、このファイルの中身を丸ごと貼って RUN。
--   何度実行しても壊れない。schema.sql を先に実行してあること。
--
-- ■ 中身（migrations/ の 002・003・004 をこの順につないだもの）
--   002 … 食堂・時間割・課外活動の団体
--   003 … 学部17学科・課外活動97団体・もとにした Word
--   004 … 時限の時刻・イベント・登録の優先順位・知らせ
--
--   一つずつ実行したい場合は migrations/ の中の同じ名前のファイルを使う。



-- ###############################################################
-- ## 002_cafeteria_timetable.sql
-- ###############################################################

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


-- ###############################################################
-- ## 003_departments_activities.sql
-- ###############################################################

-- KIT map — 学部・学科と課外活動
--
-- Supabase の SQL Editor に貼って実行する。002 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルで決めること
--   1. 学部と学科
--   2. 課外活動の分類（体育部会・文化部会・同好会 など）と、その中の団体
--   3. もとにした Word の中身をそのまま残す場所
--
-- ■ 中身の出どころ
--   学科情報.docx      … 学部 6 / 学科 17
--   課外活動一覧.docx  … 分類 7 / 団体 97
--   写し間違いが起きないよう、Word の文章から機械的に組み立てている。


-- ===============================================================
-- 1. 学部と学科
-- ===============================================================

create table if not exists public.faculties (
  id         smallint generated always as identity primary key,
  name       text not null unique,        -- "工学部"
  sort_order smallint not null default 0
);

create table if not exists public.departments (
  id         smallint generated always as identity primary key,
  faculty_id smallint not null references public.faculties on delete cascade,
  name       text not null unique,        -- "機械工学科"
  sort_order smallint not null default 0
);

create index if not exists departments_faculty_idx
  on public.departments (faculty_id);


-- ===============================================================
-- 2. 課外活動
--
--    団体そのもの（club_activities）は 002 で作ってある。
--    ここでは分類を足して、どの部会に属すかを結び付ける。
-- ===============================================================

create table if not exists public.activity_categories (
  id         smallint generated always as identity primary key,
  -- "体育部会（スポーツ系クラブ）" のように、大学の呼び方をそのまま入れる
  name       text not null unique,
  sort_order smallint not null default 0
);

alter table public.club_activities
  add column if not exists category_id smallint
    references public.activity_categories on delete set null;

alter table public.club_activities
  add column if not exists sort_order smallint not null default 0;

create index if not exists club_activities_category_idx
  on public.club_activities (category_id);


-- ===============================================================
-- 3. もとにした Word の中身
--
--    表に取り込んだあとでも、元の文章を確かめられるように残す。
--    取り込みが正しかったかを後から見比べられる。
--
--    Word のファイルそのもの（.docx）を置きたい場合は、
--    Supabase の Storage を使う。ここに入るのは取り出した文章。
-- ===============================================================

create table if not exists public.source_documents (
  id          bigint generated always as identity primary key,
  -- departments … 学科情報
  -- activities  … 課外活動一覧
  kind        text not null check (kind in ('departments','activities','other')),
  file_name   text not null unique,
  content     text not null,
  imported_at timestamptz not null default now(),
  imported_by uuid references auth.users on delete set null
);


-- ===============================================================
-- 4. 中身の登録
-- ===============================================================

-- 学部
insert into public.faculties (name, sort_order) values
  ('工学部', 1),
  ('情報理工学部', 2),
  ('情報デザイン学部', 3),
  ('メディア情報学部', 4),
  ('建築学部', 5),
  ('バイオ・化学部', 6)
on conflict (name) do nothing;

-- 学科。学部の名前で結び付ける
insert into public.departments (faculty_id, name, sort_order)
select f.id, v.name, v.ord from (values
  ('工学部', '機械工学科', 1),
  ('工学部', '先進機械システム工学科', 2),
  ('工学部', '航空宇宙工学科', 3),
  ('工学部', '電気エネルギーシステム工学科', 4),
  ('工学部', '電子情報システム工学科', 5),
  ('工学部', '環境土木工学科', 6),
  ('情報理工学部', '情報工学科', 1),
  ('情報理工学部', '知能情報システム学科', 2),
  ('情報理工学部', 'ロボティクス学科', 3),
  ('情報デザイン学部', '経営情報学科', 1),
  ('情報デザイン学部', '環境デザイン創成学科', 2),
  ('メディア情報学部', 'メディア情報学科', 1),
  ('メディア情報学部', '心理情報デザイン学科', 2),
  ('建築学部', '建築学科', 1),
  ('建築学部', '建築デザイン学科', 2),
  ('バイオ・化学部', '環境・応用化学科', 1),
  ('バイオ・化学部', '生命・応用バイオ学科', 2)
) as v(faculty, name, ord)
join public.faculties f on f.name = v.faculty
on conflict (name) do nothing;

-- 課外活動の分類
insert into public.activity_categories (name, sort_order) values
  ('体育部会（スポーツ系クラブ）', 1),
  ('文化部会（文化系クラブ）', 2),
  ('同好会', 3),
  ('サークル', 4),
  ('夢考房プロジェクト（モノづくり等）', 5),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 6),
  ('専門委員会（大学生活運営・支援）', 7)
on conflict (name) do nothing;

-- 課外活動。分類の名前で結び付ける
insert into public.club_activities (category_id, name, sort_order)
select c.id, v.name, v.ord from (values
  ('体育部会（スポーツ系クラブ）', 'アイスホッケー部', 1),
  ('体育部会（スポーツ系クラブ）', 'アメリカンフットボール部', 2),
  ('体育部会（スポーツ系クラブ）', '空手道部', 3),
  ('体育部会（スポーツ系クラブ）', '弓道部', 4),
  ('体育部会（スポーツ系クラブ）', '競技スキー部', 5),
  ('体育部会（スポーツ系クラブ）', '剣道部', 6),
  ('体育部会（スポーツ系クラブ）', '硬式テニス部', 7),
  ('体育部会（スポーツ系クラブ）', '硬式野球部', 8),
  ('体育部会（スポーツ系クラブ）', 'ゴルフ部', 9),
  ('体育部会（スポーツ系クラブ）', 'サッカー部', 10),
  ('体育部会（スポーツ系クラブ）', '山岳部', 11),
  ('体育部会（スポーツ系クラブ）', '自動車部', 12),
  ('体育部会（スポーツ系クラブ）', '柔道部', 13),
  ('体育部会（スポーツ系クラブ）', '少林寺拳法部', 14),
  ('体育部会（スポーツ系クラブ）', '水泳部', 15),
  ('体育部会（スポーツ系クラブ）', '正伝長尾流躰術部', 16),
  ('体育部会（スポーツ系クラブ）', 'ソフトテニス部', 17),
  ('体育部会（スポーツ系クラブ）', '卓球部', 18),
  ('体育部会（スポーツ系クラブ）', '男子バスケットボール部', 19),
  ('体育部会（スポーツ系クラブ）', '女子バスケットボール部', 20),
  ('体育部会（スポーツ系クラブ）', 'バドミントン部', 21),
  ('体育部会（スポーツ系クラブ）', 'バレーボール部', 22),
  ('体育部会（スポーツ系クラブ）', 'ハンドボール部', 23),
  ('体育部会（スポーツ系クラブ）', 'ヨット部', 24),
  ('体育部会（スポーツ系クラブ）', 'ラグビー部', 25),
  ('体育部会（スポーツ系クラブ）', '陸上競技部', 26),
  ('文化部会（文化系クラブ）', 'アマチュア無線部', 1),
  ('文化部会（文化系クラブ）', '囲碁・将棋部', 2),
  ('文化部会（文化系クラブ）', 'ギターアンサンブル部', 3),
  ('文化部会（文化系クラブ）', '軽音楽部', 4),
  ('文化部会（文化系クラブ）', '写真部', 5),
  ('文化部会（文化系クラブ）', '室内管弦楽団', 6),
  ('文化部会（文化系クラブ）', '吹奏楽部', 7),
  ('文化部会（文化系クラブ）', '電子計算機研究会', 8),
  ('文化部会（文化系クラブ）', '天文部', 9),
  ('文化部会（文化系クラブ）', '美術部', 10),
  ('文化部会（文化系クラブ）', '放送研究会', 11),
  ('文化部会（文化系クラブ）', '漫画研究会', 12),
  ('同好会', '自転車同好会', 1),
  ('同好会', 'ストリートダンス同好会', 2),
  ('同好会', 'フォークソング同好会', 3),
  ('サークル', 'イマジネーション・スペースユニット・サークル', 1),
  ('サークル', 'オリエンテーリング・トレイルランニングサークル', 2),
  ('サークル', 'キッズボランティアサークル', 3),
  ('サークル', 'S・G・Eサークル', 4),
  ('サークル', '準硬式野球サークル', 5),
  ('サークル', '3on3バスケットボールサークル', 6),
  ('サークル', '釣りサークル', 7),
  ('サークル', 'T.R.P.Gサークル', 8),
  ('サークル', 'フットサルサークル', 9),
  ('サークル', 'ボウリングサークル', 10),
  ('サークル', 'ユースホステルサークル', 11),
  ('夢考房プロジェクト（モノづくり等）', '義手研究開発', 1),
  ('夢考房プロジェクト（モノづくり等）', 'エコラン', 2),
  ('夢考房プロジェクト（モノづくり等）', 'ソーラーカー', 3),
  ('夢考房プロジェクト（モノづくり等）', 'データサイエンス', 4),
  ('夢考房プロジェクト（モノづくり等）', '人力飛行機', 5),
  ('夢考房プロジェクト（モノづくり等）', 'ロボカップ', 6),
  ('夢考房プロジェクト（モノづくり等）', 'ロボット', 7),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'SDGs Global Youth Innovators.', 1),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'IoAプロジェクト', 2),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'WAVEプロジェクト', 3),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'マルチメディア考房プロジェクト', 4),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '数理考房・数検にチャレンジ！プロジェクト', 5),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '数理考房・理工学基礎プロジェクト', 6),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '数理考房・染色体解析プロジェクト', 7),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'English Podcast Series.', 8),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'KIT Community Garden.', 9),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'Toiroプロジェクト', 10),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'こどもの成長を見守る「おもちゃ」開発プロジェクト', 11),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '農業支援ロボット開発プロジェクト', 12),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'Bus Stopプロジェクト', 13),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '地域連携による企画力養成プログラム（CDAプロジェクト）', 14),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '学内のグローバル化検討プロジェクト', 15),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '教師としての実践力向上プログラム', 16),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'The Eagle on the Hilltop.', 17),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'Science Project for Children.', 18),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '地方創生・商店街活性化・DK art cafeプロジェクト', 19),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '金沢マラソン“おもてなし”プロジェクト', 20),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'マーケティング調査による商店街活性化プロジェクト', 21),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '音響エンジニアリングプロジェクト', 22),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'CirKitプロジェクト', 23),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '情報セキュリティ・スキルアッププロジェクト', 24),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'スマートフォンアプリプロジェクト', 25),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'フードクリエイション（ハチバンプロジェクト）', 26),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '金澤月見光路プロジェクト', 27),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'サイコロジェクト', 28),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '感性トレーニングプロジェクト', 29),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'Cube（キューブ）', 30),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'えこぷろ（エコ建築カフェプロジェクト）', 31),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', 'Meq(magnitude earthquake)プロジェクト', 32),
  ('課外教育活動プロジェクト（地域連携・課題解決等）', '防災・減災プロジェクト SoRA.', 33),
  ('専門委員会（大学生活運営・支援）', '学友会運営委員会', 1),
  ('専門委員会（大学生活運営・支援）', '工大祭実行委員会', 2),
  ('専門委員会（大学生活運営・支援）', 'アルバム編集委員会', 3),
  ('専門委員会（大学生活運営・支援）', '学生地域活動推進委員会', 4),
  ('専門委員会（大学生活運営・支援）', '学生支援推進委員会', 5)
) as v(cat, name, ord)
join public.activity_categories c on c.name = v.cat
on conflict (name) do nothing;

-- もとにした Word の中身をそのまま残す
insert into public.source_documents (kind, file_name, content) values
  ('departments', '学科情報.docx', '1. 工学部 
機械工学科 
先進機械システム工学科
航空宇宙工学科
電気エネルギーシステム工学科
電子情報システム工学科
環境土木工学科 
2. 情報理工学部 
情報工学科 
知能情報システム学科
ロボティクス学科 
3. 情報デザイン学部 
経営情報学科 
環境デザイン創成学科
4. メディア情報学部 
メディア情報学科 
心理情報デザイン学科 
5. 建築学部 
建築学科 
建築デザイン学科 
6. バイオ・化学部 
環境・応用化学科 
生命・応用バイオ学科'),
  ('activities',  '課外活動一覧.docx', '体育部会（スポーツ系クラブ）
アイスホッケー部
アメリカンフットボール部
空手道部
弓道部
競技スキー部
剣道部
硬式テニス部
硬式野球部
ゴルフ部
サッカー部
山岳部
自動車部
柔道部
少林寺拳法部
水泳部
正伝長尾流躰術部
ソフトテニス部
卓球部
男子バスケットボール部
女子バスケットボール部
バドミントン部
バレーボール部
ハンドボール部
ヨット部
ラグビー部
陸上競技部
文化部会（文化系クラブ）
アマチュア無線部
囲碁・将棋部
ギターアンサンブル部
軽音楽部
写真部
室内管弦楽団
吹奏楽部
電子計算機研究会
天文部
美術部
放送研究会
漫画研究会
同好会
自転車同好会
ストリートダンス同好会
フォークソング同好会
サークル
イマジネーション・スペースユニット・サークル
オリエンテーリング・トレイルランニングサークル
キッズボランティアサークル
S・G・Eサークル
準硬式野球サークル
3on3バスケットボールサークル
釣りサークル
T.R.P.Gサークル
フットサルサークル
ボウリングサークル
ユースホステルサークル
夢考房プロジェクト（モノづくり等）
義手研究開発
エコラン
ソーラーカー
データサイエンス
人力飛行機
ロボカップ
ロボット
課外教育活動プロジェクト（地域連携・課題解決等）
SDGs Global Youth Innovators.
IoAプロジェクト
WAVEプロジェクト
マルチメディア考房プロジェクト
数理考房・数検にチャレンジ！プロジェクト
数理考房・理工学基礎プロジェクト
数理考房・染色体解析プロジェクト
English Podcast Series.
KIT Community Garden.
Toiroプロジェクト
こどもの成長を見守る「おもちゃ」開発プロジェクト
農業支援ロボット開発プロジェクト
Bus Stopプロジェクト
地域連携による企画力養成プログラム（CDAプロジェクト）
学内のグローバル化検討プロジェクト
教師としての実践力向上プログラム
The Eagle on the Hilltop.
Science Project for Children.
地方創生・商店街活性化・DK art cafeプロジェクト
金沢マラソン“おもてなし”プロジェクト
マーケティング調査による商店街活性化プロジェクト
音響エンジニアリングプロジェクト
CirKitプロジェクト
情報セキュリティ・スキルアッププロジェクト
スマートフォンアプリプロジェクト
フードクリエイション（ハチバンプロジェクト）
金澤月見光路プロジェクト
サイコロジェクト
感性トレーニングプロジェクト
Cube（キューブ）
えこぷろ（エコ建築カフェプロジェクト）
Meq(magnitude earthquake)プロジェクト
防災・減災プロジェクト SoRA.
専門委員会（大学生活運営・支援）
学友会運営委員会
工大祭実行委員会
アルバム編集委員会
学生地域活動推進委員会
学生支援推進委員会')
on conflict (file_name) do update set content = excluded.content, imported_at = now();


-- ===============================================================
-- 5. アクセス制御
--
--    読めるのは承認された人だけ。書き換えは Lv2 以上。
--    もとの Word は Lv3 だけが入れ替えられる。
-- ===============================================================

alter table public.faculties           enable row level security;
alter table public.departments         enable row level security;
alter table public.activity_categories enable row level security;
alter table public.source_documents    enable row level security;

drop policy if exists "faculties read"   on public.faculties;
drop policy if exists "faculties write"  on public.faculties;
drop policy if exists "dept read"        on public.departments;
drop policy if exists "dept write"       on public.departments;
drop policy if exists "actcat read"      on public.activity_categories;
drop policy if exists "actcat write"     on public.activity_categories;
drop policy if exists "srcdoc read"      on public.source_documents;
drop policy if exists "srcdoc write"     on public.source_documents;

create policy "faculties read" on public.faculties           for select using (public.role_rank() >= 1);
create policy "dept read"      on public.departments         for select using (public.role_rank() >= 1);
create policy "actcat read"    on public.activity_categories for select using (public.role_rank() >= 1);
create policy "srcdoc read"    on public.source_documents    for select using (public.role_rank() >= 1);

create policy "faculties write" on public.faculties
  for all using (public.role_rank() >= 3) with check (public.role_rank() >= 3);
create policy "dept write" on public.departments
  for all using (public.role_rank() >= 3) with check (public.role_rank() >= 3);
create policy "actcat write" on public.activity_categories
  for all using (public.role_rank() >= 3) with check (public.role_rank() >= 3);
create policy "srcdoc write" on public.source_documents
  for all using (public.role_rank() >= 4) with check (public.role_rank() >= 4);


-- ===============================================================
-- 6. 確かめ方
-- ===============================================================
-- select f.name as 学部, d.name as 学科
-- from public.departments d join public.faculties f on f.id = d.faculty_id
-- order by f.sort_order, d.sort_order;
--
-- select c.name as 分類, count(*) as 団体数
-- from public.club_activities a join public.activity_categories c on c.id = a.category_id
-- group by c.name, c.sort_order order by c.sort_order;


-- ###############################################################
-- ## 004_events_priority.sql
-- ###############################################################

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
