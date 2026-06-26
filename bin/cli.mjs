#!/usr/bin/env node
// pbip-viewer CLI — analyze / check / html for a PBIP folder or .zip.
import fsp from "node:fs/promises";
import path from "node:path";
import { readEntries, projectBaseName } from "../lib/read-entries.mjs";
import { analyzeEntries, trimProject, summarize } from "../lib/analyze.mjs";
import { buildSelfContainedHtml } from "../lib/build-html.mjs";

const HELP = `pbip-viewer — Power BI Project (PBIP) を解析・検査・プレビュー

使い方:
  pbip-viewer analyze <path> [--json] [--raw] [--pretty]
      PBIP(フォルダ or .zip)を解析。既定は要約、--json で構造化JSON。
      --raw: 生データ(ファイル本文/画像)も含める  --pretty: 整形JSON
  pbip-viewer check <path> [--json]
      整合性を検査。エラーがあれば終了コード1(CI/エージェント用)。
  pbip-viewer html <path> [-o <out.html>]
      自己完結HTMLプレビューを書き出す(ブラウザで開く)。

例:
  pbip-viewer analyze ./MyReport.Report/.. --json --pretty
  pbip-viewer check ./MyReport && echo OK
  pbip-viewer html ./MyReport -o preview.html
`;

const ALLOWED_FLAGS = {
  analyze: new Set(["json", "raw", "pretty", "help"]),
  check: new Set(["json", "help"]),
  html: new Set(["out", "help"]),
};

function parseArgs(argv) {
  const args = { _: [], flags: {}, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help" || a === "help") {
      args.flags.help = true;
    } else if (a === "-o" || a === "--out") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) args.errors.push("-o/--out にはファイル名が必要です。");
      else args.flags.out = argv[++i];
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else args.flags[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function loadProject(inputPath) {
  const { entries, issues } = await readEntries(inputPath);
  const project = await analyzeEntries(entries, issues);
  return { entries, project };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (!ALLOWED_FLAGS[cmd]) {
    process.stderr.write(`不明なコマンド: ${cmd}\n\n` + HELP);
    process.exitCode = 2;
    return;
  }

  const { _, flags, errors } = parseArgs(argv.slice(1));

  // `<command> --help` (help anywhere after the command) prints usage with code 0.
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }

  for (const err of errors) process.stderr.write(err + "\n");
  const unknown = Object.keys(flags).filter((f) => !ALLOWED_FLAGS[cmd].has(f));
  for (const f of unknown) process.stderr.write(`不明なオプション: --${f}\n`);
  if (errors.length || unknown.length) {
    process.exitCode = 2;
    return;
  }

  const inputPath = _[0];
  if (!inputPath) {
    process.stderr.write("パスを指定してください。\n\n" + HELP);
    process.exitCode = 2;
    return;
  }

  if (cmd === "analyze") {
    const { project } = await loadProject(inputPath);
    if (flags.json) {
      const out = trimProject(project, { raw: Boolean(flags.raw) });
      process.stdout.write(JSON.stringify(out, null, flags.pretty ? 2 : 0) + "\n");
    } else {
      process.stdout.write(summarize(project) + "\n");
    }
    return;
  }

  if (cmd === "check") {
    const { project } = await loadProject(inputPath);
    const v = project.validation || { errors: 0, warnings: 0, problems: [] };
    if (flags.json) {
      process.stdout.write(JSON.stringify({ errors: v.errors, warnings: v.warnings, problems: v.problems }, null, 2) + "\n");
    } else {
      // 一覧と合計を同じ source (validation.problems) から出すことで件数のズレを防ぐ
      const problems = v.problems || [];
      if (!problems.length) process.stdout.write("検査OK: 問題は見つかりませんでした。\n");
      for (const p of problems) process.stdout.write(`[${String(p.level).toUpperCase()}] ${p.title}: ${p.detail || ""}\n`);
      process.stdout.write(`\n結果: エラー ${v.errors} / 警告 ${v.warnings}\n`);
    }
    if (v.errors > 0) process.exitCode = 1;
    return;
  }

  if (cmd === "html") {
    const { entries } = await loadProject(inputPath);
    const outPath = flags.out || `${projectBaseName(inputPath)}-preview.html`;
    const html = await buildSelfContainedHtml(entries, { title: `${projectBaseName(inputPath)} — PBIP Viewer` });
    await fsp.writeFile(path.resolve(outPath), html);
    process.stdout.write(`書き出しました: ${path.resolve(outPath)} (${html.length} bytes)\nブラウザで開いてください。\n`);
    return;
  }
}

main().catch((err) => {
  process.stderr.write(`エラー: ${err?.message || err}\n`);
  if (process.env.PBIP_DEBUG && err?.stack) process.stderr.write(err.stack + "\n");
  process.exitCode = 1;
});
