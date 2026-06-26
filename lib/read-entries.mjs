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

async function walk(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Returns { entries, issues }
export async function readEntriesFromDir(dir) {
  const root = path.resolve(dir);
  const files = await walk(root);
  const entries = [];
  const issues = [];
  for (const full of files) {
    const rel = normalizePath(path.relative(root, full));
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
    if (!isTextPath(rel)) continue;
    if (stat.size > TEXT_LIMIT) {
      issues.push({ level: "warning", title: "大きすぎるファイルをスキップしました", detail: `${rel} (${stat.size} B)` });
      continue;
    }
    entries.push({ path: rel, text: await fsp.readFile(full, "utf8"), size: stat.size });
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
  const zip = await JSZip.loadAsync(buf);
  const entries = [];
  const issues = [];
  const tasks = [];
  zip.forEach((rawPath, entry) => {
    if (entry.dir) return;
    const rel = normalizePath(rawPath);
    const size = entry._data?.uncompressedSize || 0;
    if (isImagePath(rel)) {
      if (size > IMAGE_LIMIT) {
        issues.push({ level: "warning", title: "zip内の大きすぎる画像をスキップしました", detail: `${rel} (${size} B)` });
        return;
      }
      tasks.push(entry.async("base64").then((b64) => {
        entries.push({ path: rel, text: "", isImage: true, dataUrl: `data:${imageMime(rel)};base64,${b64}`, size });
      }));
      return;
    }
    if (!isTextPath(rel)) return;
    if (size > TEXT_LIMIT) {
      issues.push({ level: "warning", title: "zip内の大きすぎるファイルをスキップしました", detail: `${rel} (${size} B)` });
      return;
    }
    tasks.push(entry.async("string").then((text) => {
      entries.push({ path: rel, text, size: size || text.length });
    }));
  });
  await Promise.all(tasks);
  return { entries, issues };
}

// Accepts a directory or a .zip path.
export async function readEntries(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`パスが見つかりません: ${inputPath}`);
  if (stat.isDirectory()) return readEntriesFromDir(resolved);
  if (/\.zip$/i.test(resolved)) return readEntriesFromZip(resolved);
  throw new Error(`フォルダまたは .zip を指定してください: ${inputPath}`);
}

export function projectBaseName(inputPath) {
  const base = path.basename(String(inputPath || "").replace(/\/+$/, ""));
  return base.replace(/\.zip$/i, "") || "pbip";
}

void fs;
