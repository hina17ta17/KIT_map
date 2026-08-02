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

/** パスワードは半角10桁ちょうど */
export function checkPassword(pw: string): string | null {
  if (pw.length !== 10) return "パスワードは10桁ちょうどにしてください";
  if (!/^[\x21-\x7e]+$/.test(pw)) return "半角の英数字・記号だけで入力してください";
  return null;
}

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
