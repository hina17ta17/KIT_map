/**
 * サーバ側の Supabase クライアント。
 *
 * ログイン状態は Cookie で持つ。Next.js の `cookies()` は非同期なので await する。
 * Server Component から呼ぶと Cookie の書き込みができないため、
 * 書き込みの失敗は握りつぶしてよい（middleware 側で更新する前提）。
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const store = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(list) {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            // Server Component からは書けない。middleware が更新するので無視してよい
          }
        },
      },
    },
  );
}
