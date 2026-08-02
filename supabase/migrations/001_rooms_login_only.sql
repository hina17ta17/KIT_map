-- 教室（rooms）をログインした人だけに見せる
--
-- 当初は「案内の最後に 302 は 3階です を出すため誰でも読める」設計にしていたが、
-- 学内の部屋情報は承認された人だけに見せる方針に変更した。
--
-- ログインなしでできるのは「何号館から何号館まで」の案内だけになる。
--
-- Supabase の SQL Editor に貼って実行する。

drop policy if exists "rooms read" on public.rooms;

create policy "rooms read" on public.rooms
  for select using (public.role_rank() >= 1);
