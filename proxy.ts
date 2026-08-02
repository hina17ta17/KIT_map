/**
 * ログイン状態（セッション）の更新。
 *
 * Cookie のトークンは期限が来ると切れる。Server Component からは
 * Cookie を書けないため、ここで毎リクエスト更新しておく。
 * これが無いと、しばらく経つとログインが切れたように見える。
 *
 * この版の Next.js では `middleware` は非推奨で、`proxy` に改名された。
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  // 環境変数が未設定の間は何もしない（フェーズ1はログイン無しで動く）
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(list) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  // 呼ぶだけでトークンが更新される
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // 画像・静的ファイル・地図データは通さない（無駄な処理を避ける）
    "/((?!_next/static|_next/image|favicon.ico|data/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
