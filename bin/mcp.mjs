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

async function loadProject(inputPath) {
  const { entries, issues } = await readEntries(inputPath);
  const project = await analyzeEntries(entries, issues);
  return { entries, project };
}

function asText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
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
  async ({ path: inputPath, includeRaw }) => {
    const { project } = await loadProject(inputPath);
    return asText(trimProject(project, { raw: Boolean(includeRaw) }));
  },
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
  async ({ path: inputPath }) => {
    const { project } = await loadProject(inputPath);
    const v = project.validation || { errors: 0, warnings: 0, problems: [] };
    return asText({
      ok: (v.errors || 0) === 0,
      errors: v.errors || 0,
      warnings: v.warnings || 0,
      problems: v.problems || [],
      summary: summarize(project),
    });
  },
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
  async ({ path: inputPath, outPath }) => {
    const { entries } = await loadProject(inputPath);
    const name = projectBaseName(inputPath);
    const out = path.resolve(outPath || `${name}-preview.html`);
    const html = await buildSelfContainedHtml(entries, { title: `${name} — PBIP Viewer` });
    await fsp.writeFile(out, html);
    return asText({ outPath: out, bytes: html.length });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
