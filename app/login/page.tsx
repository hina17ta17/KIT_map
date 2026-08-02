"use client";

/**
 * ログインと申請。
 *
 * 確認メールは送らない設計なので、登録するとすぐ「承認待ち」になる。
 * 管理者（Lv3）が承認すると学内情報が見られるようになる。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import {
  ROLE_LABEL,
  checkPassword,
  isAllowedEmail,
  type Role,
} from "@/lib/auth";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [me, setMe] = useState<{ email: string; role: Role } | null>(null);

  /** すでにログインしていれば自分の状態を出す */
  useEffect(() => {
    if (!supabaseReady) return;
    const supabase = createClient();
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: p } = await supabase
        .from("profiles")
        .select("email, role")
        .eq("id", data.user.id)
        .single();
      if (p) setMe({ email: p.email as string, role: p.role as Role });
    });
  }, []);

  const submit = async () => {
    setMsg(null);

    if (!isAllowedEmail(email)) {
      setMsg({ kind: "err", text: "大学のメールアドレスで登録してください" });
      return;
    }
    const pwErr = checkPassword(pw);
    if (pwErr) {
      setMsg({ kind: "err", text: pwErr });
      return;
    }

    setBusy(true);
    const supabase = createClient();
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password: pw });

        if (error) {
          // 「email rate limit exceeded」は Supabase が確認メールを
          // 送ろうとして送信上限に当たっている。この設計はメールを使わないので、
          // 本来は送られないはず。ただし利用者を止めないよう、
          // 作成済みなら黙ってログインに切り替えて先へ進める。
          const rateLimited = /rate limit|too many requests/i.test(error.message);
          if (rateLimited) {
            const retry = await supabase.auth.signInWithPassword({ email, password: pw });
            if (!retry.error) {
              location.href = "/";
              return;
            }
            setMsg({
              kind: "err",
              text:
                "登録の確認メールが送信上限に達しています。" +
                "管理者は Supabase の Authentication → Email → Confirm email を OFF にしてください" +
                "（このサイトはメールを使いません）。",
            });
            return;
          }
          throw error;
        }

        setMsg({
          kind: "ok",
          text: "申請しました。管理者の承認をお待ちください。",
        });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
        location.href = "/";
      }
    } catch (e) {
      setMsg({
        kind: "err",
        text: e instanceof Error ? translate(e.message) : "うまくいきませんでした",
      });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    location.reload();
  };

  return (
    <main className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-slate-950 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <Link href="/" className="text-xl font-light tracking-[0.18em] text-slate-900">
          KIT<span className="ml-1.5 font-semibold">map</span>
        </Link>

        {!supabaseReady ? (
          <>
            <p className="mt-4 rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-800">
              <b>サーバーに接続できません。</b>
              <br />
              このサイトには接続先が設定されていないため、ログインと申請を受け付けられません。
            </p>
            <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
              管理者の方へ：公開先（Vercel）の Environment Variables に
              <br />
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code>
              <br />
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
              <br />
              を登録し、もう一度デプロイしてください。
              これらはビルド時に埋め込まれるため、登録しただけでは反映されません。
            </p>
            <Link
              href="/"
              className="mt-3 block w-full rounded-xl bg-slate-100 px-4 py-3 text-center text-sm font-bold text-slate-700"
            >
              地図へ戻る
            </Link>
          </>
        ) : me ? (
          <>
            <p className="mt-4 text-sm text-slate-700">
              <b>{me.email}</b> でログイン中
            </p>
            <p className="mt-1 text-xs text-slate-500">{ROLE_LABEL[me.role]}</p>
            {me.role === "pending" && (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
                まだ承認されていません。管理者が承認すると学内情報が見られるようになります。
              </p>
            )}
            {me.role === "admin_l3" && (
              <Link
                href="/admin"
                className="mt-4 block w-full rounded-xl bg-slate-900 px-4 py-3 text-center text-sm font-bold text-white"
              >
                承認・権限の管理へ
              </Link>
            )}
            <Link
              href="/"
              className="mt-2 block w-full rounded-xl bg-slate-100 px-4 py-3 text-center text-sm font-bold text-slate-700"
            >
              地図へ戻る
            </Link>
            <button
              onClick={signOut}
              className="mt-2 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100"
            >
              ログアウト
            </button>
          </>
        ) : (
          <>
            <div className="mt-4 flex gap-1 rounded-xl bg-slate-100 p-1">
              {(["login", "signup"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setMsg(null);
                  }}
                  className={`flex-1 rounded-lg py-2 text-xs font-bold transition ${
                    mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                  }`}
                >
                  {m === "login" ? "ログイン" : "利用を申請"}
                </button>
              ))}
            </div>

            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="大学のメールアドレス"
              autoComplete="email"
              className="mt-3 w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
            <input
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              type="password"
              placeholder="パスワード（半角10桁）"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="mt-2 w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 pl-1 text-[10px] text-slate-400">{pw.length} / 10 桁</p>

            <button
              onClick={submit}
              disabled={busy}
              className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
            >
              {busy ? "処理中…" : mode === "login" ? "ログイン" : "申請する"}
            </button>

            {msg && (
              <p
                className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${
                  msg.kind === "ok"
                    ? "bg-emerald-50 text-emerald-900"
                    : "bg-red-50 text-red-800"
                }`}
              >
                {msg.text}
              </p>
            )}

            <p className="mt-4 border-t border-slate-100 pt-3 text-[10px] leading-relaxed text-slate-400">
              パスワードを忘れた場合は管理者に連絡してください。
              メールは送信されません。
            </p>
            <Link
              href="/"
              className="mt-2 block text-center text-xs font-semibold text-slate-500 hover:text-slate-700"
            >
              地図へ戻る
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

/** Supabase の英語メッセージを、利用者に伝わる日本語にする */
function translate(m: string): string {
  if (/invalid login credentials/i.test(m)) return "メールアドレスかパスワードが違います";
  if (/already registered|already been registered/i.test(m))
    return "このメールアドレスは登録済みです。［ログイン］から入ってください";
  if (/email not confirmed/i.test(m))
    return "メール確認が有効になっています。管理者は Supabase の Authentication → Email → Confirm email を OFF にしてください";
  if (/rate limit|too many requests/i.test(m))
    return "送信上限に達しています。しばらく待つか、管理者に Confirm email の解除を依頼してください";
  if (/password/i.test(m)) return "パスワードの条件を満たしていません";
  return m;
}
