/**
 * 認証まわりの共通処理。
 *
 * ログインできるのは大学のアカウントだけ。
 * ただし「弾く」のは画面側の親切であって、守っているのは RLS。
 */

/**
 * 権限。
 *
 * admin_l0 は上下の段ではなく、役目で分けたもの。
 * 大学の情報と食堂のメニューを預かる係で、予約や承認には関わらない。
 */
export type Role =
  | "pending"
  | "student"
  | "admin_l0"
  | "admin_l1"
  | "admin_l2"
  | "admin_l3";

/** 許可するメールドメイン。教職員のドメインが分かったらここに足す */
export const ALLOWED_DOMAINS = ["st.kanazawa-it.ac.jp", "kanazawa-it.ac.jp"];

export function isAllowedEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return ALLOWED_DOMAINS.includes(domain);
}

/** パスワードは半角8桁ちょうど */
export const PASSWORD_LENGTH = 8;

export function checkPassword(pw: string): string | null {
  if (pw.length !== PASSWORD_LENGTH)
    return `パスワードは${PASSWORD_LENGTH}桁ちょうどにしてください`;
  if (!/^[\x21-\x7e]+$/.test(pw)) return "半角の英数字・記号だけで入力してください";
  return null;
}

/** 学年。申請のときに選ぶ */
export const GRADES = [1, 2, 3, 4] as const;

/** 組。申請のときに選ぶ */
export const GROUPS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * クラス記号。学科ごとに決まっている。
 *
 * departments.code と同じ並び。ここに直書きしているのは、
 * 申請の画面がログイン前に出るため。ログインしていないと
 * RLS で departments を読めず、選択肢が空になってしまう。
 */
export const CLASS_CODES = [
  { code: "KM", name: "機械工学科" },
  { code: "KS", name: "先進機械システム工学科" },
  { code: "KA", name: "航空宇宙工学科" },
  { code: "KE", name: "電気エネルギーシステム工学科" },
  { code: "KI", name: "電子情報システム工学科" },
  { code: "KC", name: "環境土木工学科" },
  { code: "CC", name: "情報工学科" },
  { code: "CA", name: "知能情報システム学科" },
  { code: "CR", name: "ロボティクス学科" },
  { code: "DM", name: "経営情報学科" },
  { code: "DE", name: "環境デザイン創成学科" },
  { code: "MM", name: "メディア情報学科" },
  { code: "MP", name: "心理情報デザイン学科" },
  { code: "AE", name: "建築学科" },
  { code: "AD", name: "建築デザイン学科" },
  { code: "BE", name: "環境・応用化学科" },
  { code: "BS", name: "生命・応用バイオ学科" },
] as const;

export const ROLE_LABEL: Record<Role, string> = {
  pending: "承認待ち",
  student: "学生・教職員",
  admin_l0: "管理者 Lv0（大学の情報・食堂）",
  admin_l1: "管理者 Lv1（放課後の予約）",
  admin_l2: "管理者 Lv2（授業の予約）",
  admin_l3: "管理者 Lv3（承認・昇降格）",
};

/** 学内情報を見られるか */
export function canViewCampusInfo(role: Role | null): boolean {
  return role !== null && role !== "pending";
}

/** 承認・昇降格ができるか */
export function canManage(role: Role | null): boolean {
  return role === "admin_l3";
}

/**
 * 食堂と大学の情報を預かれるか。
 *
 * 上下の段ではなく役目で決まるので、rank の大小では判定しない。
 * 守っているのは RLS のほうで、ここは画面を出し分けるためだけのもの。
 */
export function canManageCafeteria(role: Role | null): boolean {
  return role === "admin_l0" || role === "admin_l3";
}
