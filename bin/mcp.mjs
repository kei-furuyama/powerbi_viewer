#!/usr/bin/env node
// pbip-viewer MCP server — exposes PBIP analysis/validation/render as MCP tools
// over stdio. Register with:  claude mcp add pbip-viewer -- node <abs>/bin/mcp.mjs
import path from "node:path";
import fsp from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readEntries, projectBaseName } from "../lib/read-entries.mjs";
import { analyzeEntries, trimProject, summarize } from "../lib/analyze.mjs";
import { buildSelfContainedHtml } from "../lib/build-html.mjs";
import { evaluateExpression } from "../lib/model.mjs";
import { diffProjects } from "../lib/diff.mjs";
import { buildMarkdownReport } from "../lib/report.mjs";

async function loadProject(inputPath) {
  const { entries, issues } = await readEntries(inputPath);
  const project = await analyzeEntries(entries, issues);
  return { entries, project };
}

function asText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

// Wrap a handler so any thrown error becomes a clean isError result (with an
// actionable message) instead of a raw protocol-level exception.
function safe(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      const message = err?.message || String(err);
      return { content: [{ type: "text", text: `エラー: ${message}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: "pbip-viewer", version: "1.0.0" });

server.registerTool(
  "analyze_pbip",
  {
    title: "PBIP を解析",
    description:
      "PBIP プロジェクト(フォルダ or .zip)を解析し、ページ/ビジュアル/メジャー/埋め込みデータ/検査結果を構造化JSONで返す。" +
      "includeRaw=true でファイル本文や画像も含む生データを返す(大きい)。",
    inputSchema: {
      path: z.string().describe("PBIP プロジェクトフォルダ、または .zip ファイルへのパス"),
      includeRaw: z.boolean().optional().describe("生データ(ファイル本文/画像dataURL)も含めるか。既定 false"),
    },
  },
  safe(async ({ path: inputPath, includeRaw }) => {
    const { project } = await loadProject(inputPath);
    return asText(trimProject(project, { raw: Boolean(includeRaw) }));
  }),
);

server.registerTool(
  "validate_pbip",
  {
    title: "PBIP を検査",
    description:
      "PBIP の整合性を検査し『Power BIで開けるか』を判定。{ ok, errors, warnings, problems, summary } を返す。" +
      "errors>0 なら ok=false(壊れている)。",
    inputSchema: {
      path: z.string().describe("PBIP プロジェクトフォルダ、または .zip ファイルへのパス"),
    },
  },
  safe(async ({ path: inputPath }) => {
    const { project } = await loadProject(inputPath);
    const v = project.validation || { errors: 0, warnings: 0, problems: [] };
    return asText({
      ok: (v.errors || 0) === 0,
      errors: v.errors || 0,
      warnings: v.warnings || 0,
      problems: v.problems || [],
      summary: summarize(project),
    });
  }),
);

server.registerTool(
  "render_pbip_html",
  {
    title: "PBIP を自己完結HTMLに描画",
    description:
      "PBIP を、app.js/CSS/データを内包した単一ファイルHTMLとして書き出す(オフラインでブラウザ表示可)。書き出したパスを返す。",
    inputSchema: {
      path: z.string().describe("PBIP プロジェクトフォルダ、または .zip ファイルへのパス"),
      outPath: z.string().optional().describe("出力先HTMLパス。省略時は <name>-preview.html"),
    },
  },
  safe(async ({ path: inputPath, outPath }) => {
    // Rendering only needs the raw entries (the browser re-analyzes at runtime),
    // so skip the analysis pass and stay decoupled from it.
    const { entries } = await readEntries(inputPath);
    const name = projectBaseName(inputPath);
    const out = path.resolve(outPath || `${name}-preview.html`);
    const html = await buildSelfContainedHtml(entries, { title: `${name} — PBIP Viewer` });
    await fsp.writeFile(out, html);
    return asText({ outPath: out, bytes: html.length });
  }),
);

server.registerTool(
  "evaluate_dax",
  {
    title: "DAX式を評価",
    description:
      "PBIPの埋め込みデータ(Table.FromRows)に対してDAX式を評価し結果を返す。" +
      "メジャー参照 [名前] や SUM/CALCULATE/RELATED/TOTALYTD 等に対応。" +
      "table を省略するとメジャーを持つ最初のテーブルが文脈になる。",
    inputSchema: {
      path: z.string().describe("PBIP プロジェクトフォルダ、または .zip ファイルへのパス"),
      expression: z.string().describe('評価するDAX式。例: "SUM(売上[金額])" や "[件数]"'),
      table: z.string().optional().describe("行/フィルタ文脈とするテーブル名（省略可）"),
    },
  },
  safe(async ({ path: inputPath, expression, table }) => {
    const { project } = await loadProject(inputPath);
    const result = await evaluateExpression(project, expression, table);
    return asText({ expression, table: table || null, result });
  }),
);

server.registerTool(
  "diff_pbip",
  {
    title: "2つのPBIPを差分比較",
    description:
      "2つのPBIPのページ/ビジュアル/メジャー(DAX)/列/リレーション/検査の追加・削除・変更を構造化して返す。" +
      "Claudeで再生成した前後の比較に有用。",
    inputSchema: {
      pathA: z.string().describe("比較元PBIP（フォルダ or .zip）"),
      pathB: z.string().describe("比較先PBIP（フォルダ or .zip）"),
    },
  },
  safe(async ({ pathA, pathB }) => {
    const { project: a } = await loadProject(pathA);
    const { project: b } = await loadProject(pathB);
    return asText(diffProjects(a, b));
  }),
);

server.registerTool(
  "report_pbip_markdown",
  {
    title: "PBIPのMarkdownレポート",
    description:
      "PBIPの概要・ページ別ビジュアル・メジャーのDAX・検出事項・リレーションをMarkdownで返す（outPath指定で書き出し）。",
    inputSchema: {
      path: z.string().describe("PBIP プロジェクトフォルダ、または .zip ファイルへのパス"),
      outPath: z.string().optional().describe("出力先 .md パス（省略時は本文を返す）"),
    },
  },
  safe(async ({ path: inputPath, outPath }) => {
    const { project } = await loadProject(inputPath);
    const md = buildMarkdownReport(project, projectBaseName(inputPath));
    if (outPath) {
      const out = path.resolve(outPath);
      await fsp.writeFile(out, md);
      return asText({ outPath: out, bytes: md.length });
    }
    return asText(md);
  }),
);

// stdout is the JSON-RPC channel; all diagnostics must go to stderr only.
process.on("uncaughtException", (err) => {
  process.stderr.write(`pbip-viewer-mcp 未捕捉エラー: ${err?.stack || err}\n`);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`pbip-viewer-mcp 未処理のPromise拒否: ${err?.stack || err}\n`);
});

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  process.stderr.write(`pbip-viewer-mcp の起動に失敗しました: ${err?.message || err}\n`);
  process.exit(1);
}
