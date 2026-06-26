// Run the DOM-free analyzeProject from app.js over a set of entries.
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app.js");

let parserPromise;
async function getParser() {
  if (!parserPromise) {
    parserPromise = import(APP).then(() => {
      const parser = globalThis.PBIPViewerParser;
      if (!parser?.analyzeProject) throw new Error("app.js から PBIPViewerParser を読み込めませんでした");
      return parser;
    });
  }
  return parserPromise;
}

export async function analyzeEntries(entries, incomingIssues = []) {
  const { analyzeProject } = await getParser();
  return analyzeProject(entries, incomingIssues);
}

// Strip heavy/raw fields for a clean JSON payload (CLI/MCP/agents).
export function trimProject(project, { raw = false } = {}) {
  if (raw || !project) return project;
  const clone = structuredClone(project);

  clone.entries = (clone.entries || []).map((e) => ({
    path: e.path,
    type: e.type,
    size: e.size,
    isImage: Boolean(e.isImage),
    jsonStatus: e.jsonError ? "error" : e.json ? "parsed" : "loaded",
  }));
  clone.pbipFiles = (clone.pbipFiles || []).map((e) => e.path);

  if (clone.report) {
    delete clone.report.reportJson;
    delete clone.report.definitionPbir;
    delete clone.report.pagesJson;
    for (const page of clone.report.pages || []) {
      delete page.json;
      for (const v of page.visuals || []) delete v.imageData;
    }
    for (const v of clone.report.visuals || []) delete v.imageData;
  }

  for (const t of clone.semantic?.tables || []) {
    if (t.data) t.data = { columns: t.data.columns, rows: (t.data.records || []).length };
  }

  return clone;
}

// Compact human-readable summary lines.
export function summarize(project) {
  const r = project.report || {};
  const v = project.validation || { errors: 0, warnings: 0 };
  const check = v.errors > 0 ? `NG(エラー${v.errors})` : v.warnings > 0 ? `△(警告${v.warnings})` : "OK";
  const lines = [];
  lines.push(`ページ: ${r.pages?.length || 0}  ビジュアル: ${r.visuals?.length || 0}  テーブル: ${project.semantic?.tables?.length || 0}  検査: ${check}`);
  const loaded = project.dataModel?.loadedTables || [];
  if (loaded.length) lines.push(`埋め込みデータ: ${loaded.map((t) => `${t.name}(${t.rows}行)`).join(", ")}`);
  for (const page of r.pages || []) {
    const visuals = page.visuals || [];
    lines.push(`\n[${page.displayName}] ${Math.round(page.width)}x${Math.round(page.height)} / ${visuals.length} visuals`);
    for (const vis of visuals) {
      const roles = (vis.roles || []).map((role) => `${role.role}=${(role.fields || []).map((f) => f.label).join(",")}`).join(" ");
      lines.push(`  - ${vis.typeLabel} "${vis.title}"${roles ? "  " + roles : ""}`);
    }
  }
  return lines.join("\n");
}
