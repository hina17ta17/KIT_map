/**
 * 表示の言葉を切り替える。
 *
 * 既定は日本語。英語に切り替えると、画面の文字と建物の名前が英語になる。
 *
 * 対応表は「日本語の文言そのもの」を鍵にしている。
 * 別に鍵を作ると、日本語のまま使う場所と対応表がずれても気づけない。
 * 対応表に無い言葉は、そのまま日本語で出す（消えるより読めるほうがよい）。
 */

export type Lang = "ja" | "en";

/** 覚えておく名前 */
export const LANG_KEY = "kitmap.lang";

const EN: Record<string, string> = {
  /* ボタンと見出し */
  現在地: "My location",
  案内: "Route",
  "案内をはじめる": "Start",
  "案内を消す": "Clear route",
  "案内を終える": "Finish",
  "地図に戻る": "Back to map",
  お気に入り: "Favorites",
  "★ お気に入り": "★ Favorites",
  建物一覧: "Buildings",
  出発地: "From",
  目的地: "To",
  出発: "From",
  "現在地を使う": "Use my location",
  閉じる: "Close",
  やめる: "Cancel",
  施設: "Facilities",
  その他: "Others",
  "学内の情報": "Campus info",
  ログイン: "Log in",
  "ログイン画面へ": "Go to log in",
  "目的地を選んでください": "Choose a destination",
  "次に目的地のラベルを押してください": "Now tap the destination",

  /* 到着 */
  到着しました: "You have arrived",
  "建物の中では": "Inside the building",
  "ここから中に入って、この階へ向かってください": "Go inside and head to this floor",
  "建物の前に着きました": "You are at the entrance",

  /* 現在地の状態 */
  "現在地を取得中…（初回は30秒ほどかかります）": "Finding your location… (up to 30s)",
  "精度を上げています…": "Improving accuracy…",
  "衛星で測れています（GPS・みちびき等）": "Using satellites (GPS, QZSS…)",
  "いまは Wi-Fi や基地局からの推定です。空の見える場所で少し待つと、衛星に切り替わります":
    "Estimated from Wi-Fi / cell towers. Move where you can see the sky and wait.",
  "圏外（キャンパス外）": "Outside campus",
  "現在地が拒否されています": "Location is blocked",
  "測位できませんでした": "Could not get your location",
  "もう一度試す": "Try again",
  "許可し直したら押す": "Tap after allowing",
  "この接続では現在地を使えません": "Location needs a secure connection",
  "この端末では現在地を使えません": "Location is not available on this device",
  "屋内では取得しにくくなります。窓際か屋外でお試しください":
    "Hard to get indoors. Try near a window or outside.",
  "iPhone：設定 → プライバシー → 位置情報サービス → Safari を「確認」か「許可」に":
    "iPhone: Settings → Privacy → Location Services → Safari → Ask or Allow",

  /* 案内の途中 */
  "計算中…": "Calculating…",
  正門: "Main gate",

  /* うまくいかないとき */
  "経路の起点が見つかりません": "No starting point found",
  "出発地の入口が登録されていません": "No entrance registered for the start",
  "目的地の入口が登録されていません": "No entrance registered for the destination",
  "経路が見つかりませんでした": "No route found",

  /* 説明 */
  "よく行く場所に★を付けると、案内の入力欄と建物一覧のいちばん上に出ます。":
    "Star the places you visit often. They appear at the top of the search and the building list.",
  "大学のアカウントのみ利用できます。承認された学生・教職員が対象です。":
    "University accounts only, once approved by an administrator.",
  "閲覧には管理者の承認が必要です。": "Requires administrator approval.",
  "日にちを押すと、その日の情報が開きます": "Tap a date to open that day",
  "金沢工業大学 扇が丘キャンパス": "Kanazawa Institute of Technology, Ogigaoka Campus",
};

/** 建物の名前のうち、号館ではないもの */
const EN_PLACE: Record<string, string> = {
  グラウンド: "Athletic Field",
  テニスコート: "Tennis Courts",
  "金沢工業大学前バス停": "KIT-mae Bus Stop",
  "野々市工大前バス停": "Nonoichi-Kodai-mae Bus Stop",
  "野々市工大前駅": "Nonoichi-Kodai-mae Station",
  バス停: "Bus Stop",
  "自転車(北)": "Bicycle Parking (N)",
  "自転車(北2)": "Bicycle Parking (N2)",
  "自転車(東)": "Bicycle Parking (E)",
  "自転車(東2)": "Bicycle Parking (E2)",
  "自転車(西)": "Bicycle Parking (W)",
  "自転車(南)": "Bicycle Parking (S)",
  "LC(6号館)": "LC (Bldg. 6)",
};

/** 全角半角の括弧ゆれを吸収して引く */
const loose = (s: string) => s.replace(/[（）()\s]/g, "");
const PLACE_LOOSE: Record<string, string> = {};
for (const [k, v] of Object.entries(EN_PLACE)) PLACE_LOOSE[loose(k)] = v;

/** 画面の文言を訳す。対応表に無ければ日本語のまま返す */
export function t(lang: Lang, ja: string): string {
  if (lang === "ja") return ja;
  return EN[ja] ?? ja;
}

/**
 * 建物の名前を訳す。
 *
 * 「23号館」のように番号で決まるものは、対応表に載せずに組み立てる。
 * 47棟ぶん並べても、増えたときに書き足し忘れるだけなので。
 */
export function placeName(lang: Lang, name: string): string {
  if (lang === "ja" || !name) return name;

  const known = PLACE_LOOSE[loose(name)];
  if (known) return known;

  const m = /^(\d+)\s*号館$/.exec(name.trim());
  if (m) return `Bldg. ${m[1]}`;

  // 「LC(6号館)」のように、名前の中に号館を含むもの
  return name.replace(/(\d+)\s*号館/g, "Bldg. $1");
}

/** 「3階」「地下1階」を訳す */
export function floorLabelIn(lang: Lang, sub: string): string {
  if (lang === "ja" || !sub) return sub;
  const b = /^地下(\d+)階$/.exec(sub);
  if (b) return `B${b[1]}F`;
  const f = /^(\d+)階$/.exec(sub);
  if (f) return `${f[1]}F`;
  return sub;
}
