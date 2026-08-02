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
