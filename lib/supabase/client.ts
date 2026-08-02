/**
 * ブラウザ側の Supabase クライアント。
 *
 * ここで使う `anon key` は公開前提のキー。
 * ブラウザに埋め込まれるので秘密ではない。
 * **データを守るのは RLS（Row Level Security）であって、キーの秘匿ではない。**
 * したがって RLS を切ってはいけない。
 */

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
