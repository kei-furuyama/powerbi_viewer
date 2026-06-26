// Read a PBIP project (folder or .zip) from disk into the `entries` shape
// consumed by analyzeProject: [{ path, text, size, isImage?, dataUrl? }].
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const TEXT_LIMIT = 8 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;

const TEXT_RE = /\.(pbip|pbir|pbism|bim|json|tmdl|platform|txt)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

export function isTextPath(p) {
  return TEXT_RE.test(p);
}
export function isImagePath(p) {
  return IMAGE_RE.test(p);
}

export function imageMime(p) {
  const ext = (p.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  return `image/${ext || "png"}`;
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function walk(dir, issues, visited, root) {
  const out = [];
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Unreadable directory (permissions, races): warn and skip, don't abort.
    issues.push({ level: "warning", title: "フォルダを読み取れませんでした", detail: `${dir}: ${err?.code || err?.message || err}` });
    return out;
  }
  for (const entry of dirents) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, issues, visited, root)));
    } else if (entry.isFile()) {
      out.push(full);
    } else if (entry.isSymbolicLink()) {
      // Follow symlinks but guard against loops via real-path tracking.
      let real;
      try {
        real = await fsp.realpath(full);
      } catch {
        issues.push({ level: "warning", title: "壊れたシンボリックリンクをスキップしました", detail: full });
        continue;
      }
      // プロジェクトルート外を指すシンボリックリンクは辿らない(任意ファイル読み出し防止)
      if (root && !isInside(root, real)) {
        issues.push({ level: "warning", title: "プロジェクト外を指すリンクをスキップしました", detail: full });
        continue;
      }
      if (visited.has(real)) continue;
      visited.add(real);
      const st = await fsp.stat(real).catch(() => null);
      if (st?.isDirectory()) {
        // 子のパスは実体(real)ではなくリンク位置(full)を起点に付け替え、
        // プロジェクトルート外へ relative が逃げないようにする。
        const children = await walk(real, issues, visited, root);
        for (const child of children) out.push(path.join(full, path.relative(real, child)));
      } else if (st?.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

// Returns { entries, issues }
export async function readEntriesFromDir(dir) {
  const root = path.resolve(dir);
  const issues = [];
  const files = await walk(root, issues, new Set([root]), root);
  const entries = [];
  // ルート自体が *.Report / *.SemanticModel の場合、その basename を相対パスへ前置して
  // アンカー付きの構造チェック(definition/pages 等)が効くようにする。
  const rootBase = path.basename(root);
  const prefix = /\.(Report|SemanticModel|pbip)$/i.test(rootBase) ? `${rootBase}/` : "";
  for (const full of files) {
    const rel = prefix + normalizePath(path.relative(root, full));
    if (!isImagePath(rel) && !isTextPath(rel)) continue;
    try {
      const stat = await fsp.stat(full);
      if (isImagePath(rel)) {
        if (stat.size > IMAGE_LIMIT) {
          issues.push({ level: "warning", title: "大きすぎる画像をスキップしました", detail: `${rel} (${stat.size} B)` });
          continue;
        }
        const buf = await fsp.readFile(full);
        entries.push({ path: rel, text: "", isImage: true, dataUrl: `data:${imageMime(rel)};base64,${buf.toString("base64")}`, size: stat.size });
        continue;
      }
      if (stat.size > TEXT_LIMIT) {
        issues.push({ level: "warning", title: "大きすぎるファイルをスキップしました", detail: `${rel} (${stat.size} B)` });
        continue;
      }
      entries.push({ path: rel, text: await fsp.readFile(full, "utf8"), size: stat.size });
    } catch (err) {
      // A single unreadable file shouldn't kill the whole load.
      issues.push({ level: "warning", title: "ファイルを読み取れませんでした", detail: `${rel}: ${err?.code || err?.message || err}` });
    }
  }
  return { entries, issues };
}

export async function readEntriesFromZip(zipPath) {
  let JSZip;
  try {
    ({ default: JSZip } = await import("jszip"));
  } catch {
    throw new Error("zip入力には jszip が必要です。`npm install` を実行してください。");
  }
  const buf = await fsp.readFile(zipPath);
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    throw new Error(`zipを展開できませんでした（壊れているか、zip形式ではありません）: ${err?.message || err}`);
  }
  const entries = [];
  const issues = [];
  const tasks = [];
  zip.forEach((rawPath, entry) => {
    if (entry.dir) return;
    const rel = normalizePath(rawPath);
    // macOSのzipサイドカー(__MACOSX / ._* / .DS_Store)は無視(偽の検査エラーを防ぐ)
    if (/(^|\/)__MACOSX\//.test(rel) || /(^|\/)\._/.test(rel) || /(^|\/)\.DS_Store$/i.test(rel)) return;
    // Optional fast pre-filter from JSZip's (private) size hint; never used to
    // ENFORCE the limit, so a missing/renamed field can't bypass the cap below.
    const hint = entry._data?.uncompressedSize;
    if (isImagePath(rel)) {
      if (hint > IMAGE_LIMIT) {
        issues.push({ level: "warning", title: "zip内の大きすぎる画像をスキップしました", detail: `${rel} (${hint} B)` });
        return;
      }
      tasks.push(entry.async("uint8array").then((u8) => {
        if (u8.byteLength > IMAGE_LIMIT) {
          issues.push({ level: "warning", title: "zip内の大きすぎる画像をスキップしました", detail: `${rel} (${u8.byteLength} B)` });
          return;
        }
        entries.push({ path: rel, text: "", isImage: true, dataUrl: `data:${imageMime(rel)};base64,${Buffer.from(u8).toString("base64")}`, size: u8.byteLength });
      }));
      return;
    }
    if (!isTextPath(rel)) return;
    if (hint > TEXT_LIMIT) {
      issues.push({ level: "warning", title: "zip内の大きすぎるファイルをスキップしました", detail: `${rel} (${hint} B)` });
      return;
    }
    tasks.push(entry.async("string").then((text) => {
      const size = Buffer.byteLength(text, "utf8");
      if (size > TEXT_LIMIT) {
        issues.push({ level: "warning", title: "zip内の大きすぎるファイルをスキップしました", detail: `${rel} (${size} B)` });
        return;
      }
      entries.push({ path: rel, text, size });
    }));
  });
  await Promise.all(tasks);
  return { entries, issues };
}

const PBIP_HINT_RE = /\.(pbip|pbir|pbism|bim|tmdl)$|(^|\/)(report|pages|definition)\.(json|pbir)$|(^|\/)report\.json$/i;

// Accepts a directory or a .zip path. Throws clear, actionable errors.
export async function readEntries(inputPath) {
  if (!inputPath || !String(inputPath).trim()) {
    throw new Error("パスが指定されていません。フォルダまたは .zip を指定してください。");
  }
  const resolved = path.resolve(inputPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`パスが見つかりません: ${inputPath}`);

  let result;
  if (stat.isDirectory()) result = await readEntriesFromDir(resolved);
  else if (/\.zip$/i.test(resolved)) result = await readEntriesFromZip(resolved);
  else throw new Error(`フォルダまたは .zip を指定してください（指定: ${inputPath}）`);

  const { entries, issues } = result;
  if (!entries.length) {
    throw new Error(
      `読み取れるファイルがありませんでした: ${inputPath}\n` +
        "PBIPプロジェクトのフォルダ（*.pbip / *.Report / *.SemanticModel を含む）か、それをまとめた .zip を指定してください。"
    );
  }
  if (!entries.some((e) => PBIP_HINT_RE.test(e.path))) {
    issues.push({
      level: "warning",
      title: "PBIPらしきファイルが見つかりません",
      detail: "*.pbip / definition.pbir / report.json / *.tmdl などが無いため、解析結果が空になる可能性があります。フォルダごと選択しているか確認してください。",
    });
  }
  return { entries, issues };
}

export function projectBaseName(inputPath) {
  const base = path.basename(String(inputPath || "").replace(/\/+$/, ""));
  return base.replace(/\.zip$/i, "") || "pbip";
}

void fs;
