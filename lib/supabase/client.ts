/**
 * ブラウザ側の Supabase クライアント。
 *
 * ここで使う `anon key` は公開前提のキー。
 * ブラウザに埋め込まれるので秘密ではない。
 * **データを守るのは RLS（Row Level Security）であって、キーの秘匿ではない。**
 * したがって RLS を切ってはいけない。
 */

import { createBrowserClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * 接続先が埋め込まれているか。
 *
 * `NEXT_PUBLIC_` の値は **ビルドしたときに** コードへ焼き込まれる。
 * 手元の .env.local にあっても、公開先（Vercel）に登録していなければ
 * 空のまま公開されてしまい、ログインだけが動かない状態になる。
 * 空のまま createBrowserClient を呼ぶと英語の例外で画面が壊れるので、
 * 呼ぶ前にこれで確かめて、日本語で理由を出す。
 */
export const supabaseReady = Boolean(URL && KEY);

export function createClient() {
  if (!supabaseReady) {
    throw new Error("接続先が設定されていません");
  }
  return createBrowserClient(URL, KEY);
}
