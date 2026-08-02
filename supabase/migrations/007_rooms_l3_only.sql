-- KIT map — 教室の登録は Lv3 だけにする
--
-- Supabase の SQL Editor に貼って実行する。006 のあとに実行すること。
-- 何度実行しても壊れないように書いてある。
--
-- ■ なぜ絞るか
--   教室は建物と経路の土台になる情報で、番号を変えたり消したりすると
--   時間割・予約・案内までまとめて道連れになる。
--   画面側でも隠すが、守っているのはここ（RLS）。
--   画面を書き換えられても、権限が足りなければ書き込みは通らない。
--
--   読むのは今までどおり、承認された人なら誰でもできる。
--   案内の最後に「302 は 3階です」を出すのに要るため。

drop policy if exists "rooms write" on public.rooms;

create policy "rooms write" on public.rooms
  for all
  using (public.role_rank() >= 4)
  with check (public.role_rank() >= 4);


-- ===============================================================
-- 確かめ方
-- ===============================================================
-- select polname, pg_get_expr(polqual, polrelid) as using_expr
-- from pg_policy where polrelid = 'public.rooms'::regclass;
--   → rooms write の条件が role_rank() >= 4 になっていればよい
