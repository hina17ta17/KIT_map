-- KIT map — 管理者Lv0（大学の情報・食堂）
--
-- Supabase の SQL Editor に貼って実行する。007 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ このファイルで決めること
--   1. admin_l0 という役目を足す
--   2. 食堂を預かれるのは Lv0 と Lv3 だけにする
--   3. 大学の情報（学部・学科・課外活動）も Lv0 が預かれるようにする
--
-- ■ Lv0 は「一番下の管理者」ではない
--   上下の段ではなく、役目で分けたもの。
--   大学の情報と食堂のメニューを預かる係で、予約や承認には関わらない。
--   そのため rank の大小では判定せず、役目そのもので見る。


-- ===============================================================
-- 1. 役目を足す
-- ===============================================================

alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('pending','student','admin_l0','admin_l1','admin_l2','admin_l3'));

-- 学内情報を読めるところまでは学生と同じ。
-- 予約や授業の登録には関わらないので、それより上には置かない
create or replace function public.role_rank()
returns int language sql stable security definer set search_path = public as $$
  select case public.my_role()
    when 'admin_l3' then 4
    when 'admin_l2' then 3
    when 'admin_l1' then 2
    when 'admin_l0' then 1
    when 'student'  then 1
    else 0
  end;
$$;


-- ===============================================================
-- 2. 食堂と大学の情報を預かれるか
-- ===============================================================

create or replace function public.can_manage_campus()
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() in ('admin_l0','admin_l3');
$$;

comment on function public.can_manage_campus is
  '大学の情報と食堂を預かれるか。Lv0 と Lv3 のみ。'
  '上下の段ではなく役目で決まるので rank では判定しない。';


-- ===============================================================
-- 3. 食堂 — 書き込めるのは Lv0 と Lv3 だけ
-- ===============================================================

drop policy if exists "cafeterias write" on public.cafeterias;
drop policy if exists "menus write"      on public.menus;
drop policy if exists "items write"      on public.cafeteria_items;
drop policy if exists "counter write"    on public.counter_days;
drop policy if exists "menu write"       on public.menu_days;

create policy "cafeterias write" on public.cafeterias
  for all using (public.can_manage_campus()) with check (public.can_manage_campus());
create policy "menus write" on public.menus
  for all using (public.can_manage_campus()) with check (public.can_manage_campus());
create policy "items write" on public.cafeteria_items
  for all using (public.can_manage_campus()) with check (public.can_manage_campus());
create policy "counter write" on public.counter_days
  for all using (public.can_manage_campus()) with check (public.can_manage_campus());
create policy "menu write" on public.menu_days
  for all using (public.can_manage_campus()) with check (public.can_manage_campus());


-- ===============================================================
-- 4. 大学の情報 — Lv0 も預かれるようにする
--
--    学部・学科・課外活動の一覧と、もとにした Word。
--    これまでの Lv2 以上も、そのまま触れる。
-- ===============================================================

drop policy if exists "faculties write" on public.faculties;
drop policy if exists "dept write"      on public.departments;
drop policy if exists "actcat write"    on public.activity_categories;
drop policy if exists "activities write" on public.club_activities;
drop policy if exists "srcdoc write"    on public.source_documents;

create policy "faculties write" on public.faculties
  for all using (public.can_manage_campus() or public.role_rank() >= 3)
  with check (public.can_manage_campus() or public.role_rank() >= 3);

create policy "dept write" on public.departments
  for all using (public.can_manage_campus() or public.role_rank() >= 3)
  with check (public.can_manage_campus() or public.role_rank() >= 3);

create policy "actcat write" on public.activity_categories
  for all using (public.can_manage_campus() or public.role_rank() >= 3)
  with check (public.can_manage_campus() or public.role_rank() >= 3);

create policy "activities write" on public.club_activities
  for all using (public.can_manage_campus() or public.role_rank() >= 3)
  with check (public.can_manage_campus() or public.role_rank() >= 3);

-- もとの Word は差し替えの影響が大きいので Lv0 と Lv3 だけ
create policy "srcdoc write" on public.source_documents
  for all using (public.can_manage_campus()) with check (public.can_manage_campus());


-- ===============================================================
-- 5. 予定の削除
--
--    入れた本人と Lv3 に加えて、授業は Lv2 も片づけられるようにする。
--    担当が代わったときに、前の人でないと消せないのは困るため。
-- ===============================================================

drop policy if exists "tt delete" on public.timetable;

create policy "tt delete" on public.timetable
  for delete using (
    created_by = auth.uid()
    or public.role_rank() >= 4
    or (kind = 'class' and public.role_rank() >= 3)
  );


-- ===============================================================
-- 6. 確かめ方
-- ===============================================================
-- 誰かを Lv0 にする
-- update public.profiles set role = 'admin_l0' where email = 'ここにメール';
--
-- select public.can_manage_campus();
--   → Lv0 か Lv3 でログインしていれば true
