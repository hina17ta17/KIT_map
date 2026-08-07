"use client";

/**
 * ログインと利用の申請。
 *
 * ■ 申請の流れ
 *   ① メールアドレスと氏名を入れて［START］
 *      → 大学のドメインでないと押せない
 *   ② 届いたメールのリンクで本人確認
 *   ③ 認証アプリ（Authenticator）で二段階の確認を登録
 *   ④ 学年・クラス・組・パスワードを入れて申請完了
 *      → 管理者が承認するまでは学内情報を見られない
 *
 * メールと認証アプリの二つを通すのは、
 * 大学のアドレスを騙られても、その人自身でないと進めないようにするため。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminMenu } from "@/components/AdminNav";
import {
  CLASS_CODES,
  GRADES,
  GROUPS,
  PASSWORD_LENGTH,
  ROLE_LABEL,
  checkPassword,
  isAllowedEmail,
  type Role,
} from "@/lib/auth";

/** 申請のどこまで進んだか */
type Step = "start" | "mail" | "mfa" | "detail" | "done";

type Me = {
  email: string;
  role: Role;
  full_name: string;
  grade: number;
  class_code: string;
  group_no: number;
  verified: boolean;
};

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  /* ログイン */
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");

  /* 申請 */
  const [step, setStep] = useState<Step>("start");
  const [name, setName] = useState("");
  const [grade, setGrade] = useState<number>(0);
  const [classCode, setClassCode] = useState("");
  const [groupNo, setGroupNo] = useState<number>(0);
  /** 認証アプリに読ませるQRと、手で入れる用の文字列 */
  const [mfa, setMfa] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const reload = useCallback(async () => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      setMe(null);
      setLoading(false);
      return;
    }
    const { data: p } = await supabase
      .from("profiles")
      .select("email, role, full_name, grade, class_code, group_no, verified")
      .eq("id", data.user.id)
      .single();
    if (p) {
      const row = p as Me;
      setMe(row);
      // 途中で閉じた人が続きから進められるようにする
      setName(row.full_name);
      setGrade(row.grade);
      setClassCode(row.class_code);
      setGroupNo(row.group_no);
      if (!row.verified) setStep("mfa");
      else if (!row.grade || !row.class_code || !row.group_no) setStep("detail");
      else setStep("done");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ---------------- ① START：メールを送る ---------------- */

  const domainOk = isAllowedEmail(email);
  const canStart = domainOk && name.trim().length > 0;

  const start = async () => {
    setMsg(null);
    if (!canStart) return;
    setBusy(true);
    try {
      const { error } = await createClient().auth.signInWithOtp({
        email: email.trim(),
        options: {
          data: { full_name: name.trim() },
          emailRedirectTo: typeof window !== "undefined" ? `${location.origin}/login` : undefined,
        },
      });
      if (error) throw error;
      setStep("mail");
      setMsg({
        kind: "info",
        text: "確認のメールを送りました。届いたリンクを開いてください。",
      });
    } catch (e) {
      setMsg({ kind: "err", text: translate(e) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ③ 認証アプリを登録する ---------------- */

  const enroll = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const supabase = createClient();
      // 途中でやめた登録が残っていると新しく作れない。片づけてから始める
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of list?.all ?? []) {
        if (f.factor_type === "totp" && f.status !== "verified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) throw error;
      setMfa({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch (e) {
      setMsg({ kind: "err", text: translate(e) });
    } finally {
      setBusy(false);
    }
  };

  const verifyMfa = async () => {
    setMsg(null);
    if (!mfa) return;
    if (!/^\d{6}$/.test(code)) {
      setMsg({ kind: "err", text: "6桁の数字を入れてください" });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId: mfa.id });
      if (e1) throw e1;
      const { error: e2 } = await supabase.auth.mfa.verify({
        factorId: mfa.id,
        challengeId: ch.id,
        code,
      });
      if (e2) throw e2;

      const { error: e3 } = await supabase
        .from("profiles")
        .update({ verified: true })
        .eq("email", email || me?.email || "");
      if (e3) throw e3;

      setCode("");
      setStep("detail");
      setMsg({ kind: "ok", text: "本人確認ができました。最後に所属を入れてください。" });
    } catch (e) {
      setMsg({ kind: "err", text: translate(e) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ④ 所属とパスワード ---------------- */

  const finish = async () => {
    setMsg(null);
    if (!grade || !classCode || !groupNo) {
      setMsg({ kind: "err", text: "学年・クラス・組をすべて選んでください" });
      return;
    }
    const pwErr = checkPassword(pw);
    if (pwErr) {
      setMsg({ kind: "err", text: pwErr });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      // 以降ふつうに入れるよう、ここでパスワードを決める
      const { error: e1 } = await supabase.auth.updateUser({ password: pw });
      if (e1) throw e1;

      const { data: u } = await supabase.auth.getUser();
      const { error: e2 } = await supabase
        .from("profiles")
        .update({
          full_name: name.trim(),
          grade,
          class_code: classCode,
          group_no: groupNo,
        })
        .eq("id", u.user?.id ?? "");
      if (e2) throw e2;

      setPw("");
      setStep("done");
      await reload();
      setMsg({ kind: "ok", text: "申請しました。管理者の承認をお待ちください。" });
    } catch (e) {
      setMsg({ kind: "err", text: translate(e) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ログイン ---------------- */

  const signIn = async () => {
    setMsg(null);
    if (!isAllowedEmail(email)) {
      setMsg({ kind: "err", text: "大学のメールアドレスで入ってください" });
      return;
    }
    setBusy(true);
    try {
      const { error } = await createClient().auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
      location.href = "/";
    } catch (e) {
      setMsg({ kind: "err", text: translate(e) });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    location.reload();
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!supabaseReady)
    return (
      <Shell>
        <p className="rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-800">
          <b>サーバーに接続できません。</b>
          <br />
          接続先が設定されていないため、ログインと申請を受け付けられません。
        </p>
        <Back />
      </Shell>
    );

  /* 申請の途中、またはログイン済み */
  if (me) {
    return (
      <Shell>
        <Title />
        <p className="mt-4 text-sm text-slate-700">
          <b>{me.email}</b> でログイン中
        </p>
        <p className="mt-1 text-xs text-slate-500">{ROLE_LABEL[me.role]}</p>

        {step !== "done" ? (
          <Wizard
            step={step}
            me={me}
            {...{
              mfa,
              code,
              setCode,
              enroll,
              verifyMfa,
              grade,
              setGrade,
              classCode,
              setClassCode,
              groupNo,
              setGroupNo,
              pw,
              setPw,
              name,
              setName,
              finish,
              busy,
            }}
          />
        ) : (
          me.role === "pending" && (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
              申請は受け付けています。管理者が承認すると学内情報が見られるようになります。
            </p>
          )
        )}

        {msg && <Msg msg={msg} />}

        <div className="mt-4">
          <AdminMenu role={me.role} />
        </div>
        <Back />
        <button
          onClick={signOut}
          className="mt-2 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100"
        >
          ログアウト
        </button>
      </Shell>
    );
  }

  /* 未ログイン */
  return (
    <Shell>
      <Title />

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

      {mode === "login" ? (
        <>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="大学のメールアドレス"
            autoComplete="email"
            className={inputCls}
          />
          <input
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            type="password"
            placeholder={`パスワード（半角${PASSWORD_LENGTH}桁）`}
            autoComplete="current-password"
            className={`${inputCls} mt-2`}
          />
          <button
            onClick={signIn}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
          >
            {busy ? "処理中…" : "ログイン"}
          </button>
        </>
      ) : (
        <>
          {/* ① メールと氏名 → START */}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            大学のメールアドレスと氏名を入れて［START］を押すと、
            本人確認のメールが届きます。
          </p>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="大学のメールアドレス"
            autoComplete="email"
            className={`${inputCls} mt-2`}
          />
          {email.length > 0 && !domainOk && (
            <p className="mt-1 pl-1 text-[10px] font-bold text-red-600">
              大学のメールアドレス（@st.kanazawa-it.ac.jp など）でないと申請できません
            </p>
          )}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="氏名"
            autoComplete="name"
            className={`${inputCls} mt-2`}
          />
          <button
            onClick={start}
            disabled={!canStart || busy}
            className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold tracking-widest text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {busy ? "送信中…" : "START"}
          </button>
          {!canStart && (
            <p className="mt-1 text-center text-[10px] text-slate-400">
              メールアドレスと氏名の両方が要ります
            </p>
          )}
          {step === "mail" && (
            <p className="mt-3 rounded-xl bg-blue-50 p-3 text-xs leading-relaxed text-blue-900">
              <b>メールを確認してください。</b>
              <br />
              届いたリンクを開くと、この画面に戻って続きに進めます。
            </p>
          )}
        </>
      )}

      {msg && <Msg msg={msg} />}
      <Back />
    </Shell>
  );
}

/* ================= 申請の続き ================= */

function Wizard(props: {
  step: Step;
  me: Me;
  mfa: { id: string; qr: string; secret: string } | null;
  code: string;
  setCode: (v: string) => void;
  enroll: () => Promise<void>;
  verifyMfa: () => Promise<void>;
  grade: number;
  setGrade: (v: number) => void;
  classCode: string;
  setClassCode: (v: string) => void;
  groupNo: number;
  setGroupNo: (v: number) => void;
  pw: string;
  setPw: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  finish: () => Promise<void>;
  busy: boolean;
}) {
  const { step, mfa, code, setCode, enroll, verifyMfa, busy } = props;

  if (step === "mfa") {
    return (
      <div className="mt-4">
        <Head n={2} total={3} text="本人確認が必要です" />
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          スマートフォンの<b>認証アプリ（Authenticator）</b>で本人確認をしてください。
          Google Authenticator や Microsoft Authenticator が使えます。
        </p>

        {!mfa ? (
          <button
            onClick={() => void enroll()}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-300"
          >
            {busy ? "準備中…" : "認証アプリを登録する"}
          </button>
        ) : (
          <>
            <div className="mt-3 flex justify-center rounded-xl bg-white p-3 ring-1 ring-slate-200">
              {/* Supabase が返す QR は画像そのもの */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mfa.qr} alt="認証アプリで読み取るQR" className="h-44 w-44" />
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              読み取れない場合は、この文字列を手で入れてください
              <br />
              <code className="mt-1 block break-all rounded bg-slate-100 p-2 font-mono text-[10px]">
                {mfa.secret}
              </code>
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="アプリに出た6桁"
              className={`${inputCls} mt-3 text-center text-lg tracking-[0.4em]`}
            />
            <button
              onClick={() => void verifyMfa()}
              disabled={busy || code.length !== 6}
              className="mt-2 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? "確認中…" : "本人確認をする"}
            </button>
          </>
        )}
      </div>
    );
  }

  /* 所属とパスワード */
  const { grade, setGrade, classCode, setClassCode, groupNo, setGroupNo, pw, setPw, name, setName, finish } =
    props;

  return (
    <div className="mt-4">
      <Head n={3} total={3} text="所属を入れてください" />

      <Label>氏名</Label>
      <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />

      <Label>学年</Label>
      <div className="grid grid-cols-4 gap-1.5">
        {GRADES.map((g) => (
          <Pick key={g} on={grade === g} onClick={() => setGrade(g)}>
            {g}年
          </Pick>
        ))}
      </div>

      <Label>クラス</Label>
      <div className="grid grid-cols-4 gap-1.5">
        {CLASS_CODES.map((c) => (
          <Pick key={c.code} on={classCode === c.code} onClick={() => setClassCode(c.code)} title={c.name}>
            {c.code}
          </Pick>
        ))}
      </div>
      {classCode && (
        <p className="mt-1 text-[10px] text-slate-500">
          {CLASS_CODES.find((c) => c.code === classCode)?.name}
        </p>
      )}

      <Label>組</Label>
      <div className="grid grid-cols-7 gap-1.5">
        {GROUPS.map((g) => (
          <Pick key={g} on={groupNo === g} onClick={() => setGroupNo(g)}>
            {g}
          </Pick>
        ))}
      </div>

      <Label>パスワード（半角{PASSWORD_LENGTH}桁）</Label>
      <input
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        type="password"
        autoComplete="new-password"
        className={inputCls}
      />
      <p className="mt-1 pl-1 text-[10px] text-slate-400">
        {pw.length} / {PASSWORD_LENGTH} 桁
      </p>

      <button
        onClick={() => void finish()}
        disabled={busy}
        className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-300"
      >
        {busy ? "送信中…" : "申請を完了する"}
      </button>
    </div>
  );
}

/* ================= 小さな部品 ================= */

const inputCls =
  "w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500";

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[11px] font-bold text-slate-500">{children}</div>;
}

function Pick({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-lg py-2 text-xs font-bold transition active:scale-95 ${
        on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function Head({ n, total, text }: { n: number; total: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
        {n} / {total}
      </span>
      <span className="text-sm font-bold text-slate-900">{text}</span>
    </div>
  );
}

function Msg({ msg }: { msg: { kind: "ok" | "err" | "info"; text: string } }) {
  return (
    <p
      className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${
        msg.kind === "ok"
          ? "bg-emerald-50 text-emerald-900"
          : msg.kind === "info"
            ? "bg-blue-50 text-blue-900"
            : "bg-red-50 text-red-800"
      }`}
    >
      {msg.text}
    </p>
  );
}

function Title() {
  return (
    <Link href="/" className="text-xl font-light tracking-[0.18em] text-slate-900">
      KIT<span className="ml-1.5 font-semibold">map</span>
    </Link>
  );
}

function Back() {
  return (
    <Link
      href="/"
      className="mt-2 block w-full rounded-xl bg-slate-100 px-4 py-3 text-center text-sm font-bold text-slate-700"
    >
      地図へ戻る
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-slate-950 p-4">
      <div className="my-auto w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">{children}</div>
    </main>
  );
}

/** Supabase の英語メッセージを、利用者に伝わる日本語にする */
function translate(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/invalid login credentials/i.test(m)) return "メールアドレスかパスワードが違います";
  if (/already registered|already been registered/i.test(m))
    return "このメールアドレスは登録済みです。［ログイン］から入ってください";
  if (/rate limit|too many requests/i.test(m))
    return "メールの送信上限に達しています。しばらく待ってからお試しください";
  if (/invalid totp|invalid code|challenge/i.test(m))
    return "6桁の数字が合いません。アプリの表示を確かめて、もう一度入れてください";
  if (/factor.*already|already enrolled/i.test(m))
    return "すでに登録済みです。アプリに出ている6桁を入れてください";
  if (/mfa|totp/i.test(m)) return "認証アプリの登録に失敗しました。もう一度お試しください";
  if (/password/i.test(m)) return "パスワードの条件を満たしていません";
  return m;
}
