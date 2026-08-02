/**
 * Word（.docx）から学科情報と課外活動一覧を取り出す。
 *
 * docx は zip なので、ライブラリを足さずに自前で開く。
 * Node の zlib に生の deflate を解く道具があるので、
 * zip の索引を読んで word/document.xml だけを取り出せばよい。
 *
 * 使い方（リポジトリ直下で実行）:
 *   node scripts/extract-docx.mjs <学科情報.docx> <課外活動一覧.docx>
 *   node scripts/extract-docx.mjs ... --sql supabase/migrations/003_seed.sql
 *
 * --sql を付けると、登録用の SQL を書き出す。
 * 付けなければ、取り出した中身を並べて見せるだけ。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";

/* ---------------- zip を開く ---------------- */

/** zip の索引から、指定した名前のファイルを取り出す */
function unzip(buf, want) {
  // 末尾から索引の終わり（EOCD）を探す。コメントが付いていることがあるので後ろから
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip の索引が見つかりません");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("索引が壊れています");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (name === want) {
      // 中身の位置は、そのファイルの見出しの長さを足した先にある
      const lNameLen = buf.readUInt16LE(localAt + 26);
      const lExtraLen = buf.readUInt16LE(localAt + 28);
      const from = localAt + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(from, from + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error(`${want} が見つかりません`);
}

/** document.xml から、段落ごとの文字列を取り出す */
function paragraphs(xml) {
  return xml
    .split("</w:p>")
    .map((block) =>
      [...block.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((m) => m[1])
        .join("")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

function readDocx(path) {
  return paragraphs(unzip(readFileSync(path), "word/document.xml").toString("utf8"));
}

/* ---------------- 中身を読み解く ---------------- */

/** "1. 工学部" のような行を学部の見出しとみなす */
function parseDepartments(lines) {
  const out = [];
  for (const line of lines) {
    const m = /^\d+[.．]\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ name: m[1], depts: [] });
    else if (out.length) out.at(-1).depts.push(line);
  }
  return out;
}

// 見出しは決め打ちにする。「〜部会」だけを見ると
// 同好会・サークルのような見出しを取りこぼすため
const ACTIVITY_HEADS = [
  "体育部会（スポーツ系クラブ）",
  "文化部会（文化系クラブ）",
  "同好会",
  "サークル",
  "夢考房プロジェクト（モノづくり等）",
  "課外教育活動プロジェクト（地域連携・課題解決等）",
  "専門委員会（大学生活運営・支援）",
];

function parseActivities(lines) {
  const heads = new Set(ACTIVITY_HEADS);
  const out = [];
  for (const line of lines) {
    if (heads.has(line)) out.push({ name: line, items: [] });
    else if (out.length) out.at(-1).items.push(line);
  }
  return out;
}

/** 学科の一覧に見えるか（学部の見出しがあるか）で、どちらの資料かを見分ける */
function looksLikeDepartments(lines) {
  return lines.some((l) => /^\d+[.．]\s*.+学部|^\d+[.．]\s*.+部$/.test(l));
}

/* ---------------- SQL を組み立てる ---------------- */

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function buildSql(faculties, cats, raw) {
  const L = [];
  L.push("-- Word から機械的に作った登録文。手で直さず、作り直すこと。");
  L.push("");
  L.push("insert into public.faculties (name, sort_order) values");
  L.push(faculties.map((f, i) => `  (${q(f.name)}, ${i + 1})`).join(",\n"));
  L.push("on conflict (name) do nothing;");
  L.push("");
  L.push("insert into public.departments (faculty_id, name, sort_order)");
  L.push("select f.id, v.name, v.ord from (values");
  const d = [];
  faculties.forEach((f) => f.depts.forEach((x, i) => d.push(`  (${q(f.name)}, ${q(x)}, ${i + 1})`)));
  L.push(d.join(",\n"));
  L.push(") as v(faculty, name, ord)");
  L.push("join public.faculties f on f.name = v.faculty");
  L.push("on conflict (name) do nothing;");

  if (cats.length) {
    L.push("");
    L.push("insert into public.activity_categories (name, sort_order) values");
    L.push(cats.map((c, i) => `  (${q(c.name)}, ${i + 1})`).join(",\n"));
    L.push("on conflict (name) do nothing;");
    L.push("");
    L.push("insert into public.club_activities (category_id, name, sort_order)");
    L.push("select c.id, v.name, v.ord from (values");
    const a = [];
    cats.forEach((c) => c.items.forEach((x, i) => a.push(`  (${q(c.name)}, ${q(x)}, ${i + 1})`)));
    L.push(a.join(",\n"));
    L.push(") as v(cat, name, ord)");
    L.push("join public.activity_categories c on c.name = v.cat");
    L.push("on conflict (name) do nothing;");
  }

  L.push("");
  L.push("-- もとにした Word の中身も残す");
  L.push("insert into public.source_documents (kind, file_name, content) values");
  L.push(raw.map((r) => `  (${q(r.kind)}, ${q(r.file)}, ${q(r.text)})`).join(",\n"));
  L.push("on conflict (file_name) do update");
  L.push("  set content = excluded.content, imported_at = now();");
  return L.join("\n") + "\n";
}

/* ---------------- 実行 ---------------- */

const args = process.argv.slice(2);
const sqlAt = args.indexOf("--sql");
const sqlOut = sqlAt >= 0 ? args[sqlAt + 1] : null;
// --sql が無いときは sqlAt が -1 になる。
// このとき sqlAt + 1 は 0 なので、素直に書くと最初のファイルが消える
const files = args.filter((a, i) => (sqlAt < 0 ? true : i !== sqlAt && i !== sqlAt + 1));

if (files.length === 0) {
  console.error("使い方: node scripts/extract-docx.mjs <docx> [<docx>...] [--sql <出力先>]");
  process.exit(1);
}

let faculties = [];
let cats = [];
const raw = [];

for (const path of files) {
  const lines = readDocx(path);
  const name = basename(path);
  if (looksLikeDepartments(lines)) {
    faculties = parseDepartments(lines);
    raw.push({ kind: "departments", file: name, text: lines.join("\n") });
    console.log(`\n■ ${name} — 学部 ${faculties.length} / 学科 ${faculties.reduce((n, f) => n + f.depts.length, 0)}`);
    for (const f of faculties) {
      console.log(`  ${f.name}`);
      for (const d of f.depts) console.log(`    ・${d}`);
    }
  } else {
    cats = parseActivities(lines);
    raw.push({ kind: "activities", file: name, text: lines.join("\n") });
    const n = cats.reduce((s, c) => s + c.items.length, 0);
    console.log(`\n■ ${name} — 分類 ${cats.length} / 団体 ${n}`);
    for (const c of cats) console.log(`  ${c.name} … ${c.items.length}`);
    // 見出しの前に落ちた行があれば知らせる（見出しの決め打ちが古い可能性）
    const known = new Set(cats.flatMap((c) => [c.name, ...c.items]));
    const lost = lines.filter((l) => !known.has(l));
    if (lost.length) console.log(`  ★どの分類にも入らなかった行: ${lost.join(" / ")}`);
  }
}

if (sqlOut) {
  if (faculties.length === 0) {
    console.error("\n学科情報が読めなかったので SQL は作りません");
    process.exit(1);
  }
  writeFileSync(sqlOut, buildSql(faculties, cats, raw), "utf8");
  console.log(`\n書き出し: ${sqlOut}`);
}
