/**
 * 国土地理院タイルの定義。
 * 無料・APIキー不要。出典表示（attribution）が義務。
 * https://maps.gsi.go.jp/development/ichiran.html
 */

export type BaseId = "pale" | "photo" | "std";

/**
 * 出典表示。地理院タイルの利用条件で「出典の明示」が必須。
 * リンクにはせず文字だけにしてある（明示していれば条件を満たす）。
 */
export const GSI_ATTRIBUTION = "地理院タイル";

export const BASES: Record<
  BaseId,
  { label: string; url: string; maxzoom: number; tileSize: number }
> = {
  pale: {
    label: "淡色地図",
    url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
    maxzoom: 18,
    tileSize: 256,
  },
  photo: {
    label: "航空写真",
    url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
    maxzoom: 18,
    tileSize: 256,
  },
  std: {
    label: "標準地図",
    url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",
    maxzoom: 18,
    tileSize: 256,
  },
};

export const BASE_ORDER: BaseId[] = ["pale", "photo", "std"];

/**
 * 初期表示位置。
 *
 * 1号館（136.62794, 36.53051）と金沢工業大学前バス停（136.62841, 36.52968）の
 * 中点に置く。二点は102m しか離れておらず、起動時の縮尺なら両方が画面に入る。
 * バス停で降りた人が、そのまま1号館まで見渡せる位置。
 */
export const INITIAL_VIEW = {
  center: [136.6282, 36.5301] as [number, number],
  zoom: 16,
};

/**
 * 扇が丘キャンパスを大きめに囲む仮の矩形 [西, 南, 東, 北]。約1.1km四方。
 *
 * 正確な敷地は航空写真の上で描くのが本来だが、地図が出ない環境でも
 * 基盤地図情報の取り込みだけは進められるように用意してある。
 * 取り込み後に敷地を描き直せば、この矩形は削除してよい。
 */
export const CAMPUS_ROUGH_BBOX: [number, number, number, number] = [
  136.6234, 36.5266, 136.6354, 36.5366,
];
