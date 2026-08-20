-- KIT map — 利用者の修復と、最初の管理者を決める
--
-- Supabase の SQL Editor に貼って、上から順に実行する。
-- setup.sql（002〜010）を先に実行してあること。
--
--
-- ■ 利用者の情報は二か所に分かれている
--
--   auth.users        … Supabase が持つ「ログインの席」
--                       メールアドレスとパスワード、認証アプリの鍵。
--                       画面では Authentication → Users から見える。
--                       ここは Supabase の領分なので、直接いじらない。
--
--   public.profiles   … このアプリが持つ「その人の情報」
--                       権限・氏名・学年・クラス・組・本人確認の有無。
--                       画面では Table Editor → profiles から見える。
--                       承認画面が見ているのはこちら。
--
--   この二つは id で結ばれている。申請すると、auth.users に席ができ、
--   その合図で profiles にも行が作られる（handle_new_user）。
--
--   ★ profiles の行だけを消すと、席は残ったまま中身が無い状態になる。
--     その人はログインはできるが、承認画面に出てこない。
--     ①がその修復にあたる。


-- ===============================================================
-- ① 席はあるのに情報が無い人を作り直す
--
--    profiles を消してしまった場合や、行が作られる前に
--    仕組みを入れ替えた場合に、ここで揃え直す。
--    すでに情報がある人には触らない。
-- ===============================================================

do $repair$
declare
  n int;
begin
  insert into public.profiles (id, email, full_name)
  select u.id,
         u.email,
         coalesce(u.raw_user_meta_data->>'full_name', '')
  from auth.users u
  left join public.profiles p on p.id = u.id
  where p.id is null
    and u.email is not null;

  get diagnostics n = row_count;
  raise notice '情報が無かった % 名を作り直しました', n;
end $repair$;


-- ===============================================================
-- ② 操作パスワードを決める
--
--    すでに承認した人の権限を変えるときに要る合言葉。
--    押し間違いで一括降格させる事故を、ひと手間で防ぐためのもの。
--
--    ★下の 'CHANGE_ME' を好きな文字列に書き換えてから実行する。
--      長さや文字の決まりは無い。
--      戻せない形にしてしまうので、決めた文字列は自分で控えておくこと。
-- ===============================================================

select public.set_admin_password('CHANGE_ME');


-- ===============================================================
-- ③ 自分を管理者にする
--
--    ★下の 'you@st.kanazawa-it.ac.jp' を自分のメールに書き換える。
--
--    画面から管理者を付けられないのは、誰か一人の画面を乗っ取られた
--    時点で、承認も降格も教室の削除も全部握られてしまうため。
--    画面からの操作には必ずログインした人がいる（auth.uid() に値が入る）が、
--    この SQL Editor からは誰もいない。その違いだけで経路を分けている。
-- ===============================================================

do $first$
declare
  target text := 'you@st.kanazawa-it.ac.jp';   -- ★ここを書き換える
  n int;
begin
  update public.profiles
  set role = 'admin_l3',
      -- 管理者は本人確認の途中でも使えるようにしておく。
      -- ここで止まると、誰も承認できないまま動かせなくなる
      verified = true
  where email = target;

  get diagnostics n = row_count;

  if n = 0 then
    raise exception
      '% は見つかりませんでした。先にサイトの /login から申請してください', target;
  end if;

  raise notice '% を管理者にしました', target;
end $first$;


-- ===============================================================
-- ④ 確かめる
-- ===============================================================

-- 席と情報の数が合っているか（合っていれば同じ数になる）
select
  (select count(*) from auth.users where email is not null) as ログインの席,
  (select count(*) from public.profiles)                    as 情報のある人;

-- 誰が何の権限か
select email, role, full_name, grade, class_code, group_no, verified, created_at
from public.profiles
order by created_at;

-- 操作パスワードが入っているか
select exists (select 1 from public.admin_secrets where id = 1) as 操作パスワード設定済み;


-- ===============================================================
-- 困ったときに
-- ===============================================================
-- ・操作パスワードを変えたい
--     select public.set_admin_password('新しい文字列');
--
-- ・管理者を増やしたい（画面からは付けられないので、ここで）
--     update public.profiles set role = 'admin_l3' where email = 'もう一人のメール';
--
-- ・管理者をやめさせたい
--     update public.profiles set role = 'student' where email = 'やめる人のメール';
--   ※ 最後の一人は降格できない（protect_last_l3）。
--      先に別の人を管理者にしてから外すこと。
--
-- ・要らない席ごと消したい（情報も一緒に消える）
--     Authentication → Users から消す。
--     profiles だけを消すと、①の状態に戻ってしまう。
--
-- ・権限の意味
--     pending  … 承認待ち。地図だけ
--     student  … 学生・教職員。学内情報を見られる
--     admin_l0 … 食堂の担当
--     admin_l1 … 課外活動リーダー
--     admin_l2 … 教授
--     admin_l3 … 管理者（ここからしか付けられない）
