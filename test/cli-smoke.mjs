// CLI / lib smoke test: build a minimal PBIP on a temp dir, then exercise
// readEntries -> analyzeEntries -> validation/exit-code -> self-contained HTML.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readEntries } from "../lib/read-entries.mjs";
import { analyzeEntries, trimProject, summarize } from "../lib/analyze.mjs";
import { buildSelfContainedHtml } from "../lib/build-html.mjs";
import { evaluateExpression } from "../lib/model.mjs";
import { diffProjects } from "../lib/diff.mjs";
import { buildMarkdownReport } from "../lib/report.mjs";

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass += 1;
}

async function assertRejects(fn, re, msg) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, `${msg} — エラーが投げられなかった`);
  assert.ok(re.test(threw.message), `${msg} — メッセージ不一致: ${threw.message}`);
  pass += 1;
}

// --- Minimal valid PBIP fixture -------------------------------------------
async function writeFixture(root, { breakJson = false } = {}) {
  const reportDir = path.join(root, "Demo.Report");
  const semanticDir = path.join(root, "Demo.SemanticModel");
  const defDir = path.join(reportDir, "definition");
  const pagesDir = path.join(defDir, "pages");
  const pageDir = path.join(pagesDir, "page1");
  const visualsDir = path.join(pageDir, "visuals", "v1");
  await fsp.mkdir(visualsDir, { recursive: true });
  await fsp.mkdir(path.join(semanticDir, "definition", "tables"), { recursive: true });

  await fsp.writeFile(path.join(root, "Demo.pbip"), JSON.stringify({
    version: "1.0",
    artifacts: [{ report: { path: "Demo.Report" } }],
  }, null, 2));

  await fsp.writeFile(path.join(reportDir, "definition.pbir"), JSON.stringify({
    version: "4.0",
    datasetReference: { byPath: { path: "../Demo.SemanticModel" } },
  }, null, 2));

  await fsp.writeFile(path.join(defDir, "report.json"), JSON.stringify({
    $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/1.0.0/schema.json",
  }, null, 2));

  await fsp.writeFile(path.join(pagesDir, "pages.json"), JSON.stringify({
    pageOrder: ["page1"],
    activePageName: "page1",
  }, null, 2));

  await fsp.writeFile(path.join(pageDir, "page.json"), JSON.stringify({
    name: "page1",
    displayName: "ページ1",
    width: 1280,
    height: 720,
  }, null, 2));

  const visualJson = {
    name: "v1",
    position: { x: 40, y: 40, width: 400, height: 300, z: 0 },
    visual: {
      visualType: "card",
      objects: { general: [] },
      query: {
        queryState: {
          Values: {
            projections: [{ field: { Measure: { Property: "売上合計" } }, queryRef: "売上合計" }],
          },
        },
      },
    },
  };
  await fsp.writeFile(path.join(visualsDir, "visual.json"),
    JSON.stringify(visualJson) + (breakJson ? "  <<<broken" : ""));

  // Semantic model with one inline-data table + one measure.
  const tableTmdl = [
    "table 売上",
    "\tcolumn 月",
    "\t\tdataType: string",
    "",
    "\tcolumn 金額",
    "\t\tdataType: int64",
    "",
    "\tmeasure 売上合計 = SUM(売上[金額])",
    "",
    "\tpartition 売上 = m",
    "\t\tmode: import",
    "\t\tsource =",
    '\t\t\tlet Source = Table.FromRows({{"1月", 100}, {"2月", 200}}, {"月", "金額"}) in Source',
    "",
  ].join("\n");
  await fsp.writeFile(path.join(semanticDir, "definition", "tables", "売上.tmdl"), tableTmdl);
  await fsp.writeFile(path.join(semanticDir, "definition", "model.tmdl"),
    "model Model\n\tculture: ja-JP\n\nref table 売上\n");
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "pbip-cli-smoke-"));
  const good = path.join(base, "good");
  const bad = path.join(base, "bad");
  await writeFixture(good);
  await writeFixture(bad, { breakJson: true });

  // 1) readEntries walks the folder and picks up text + structure.
  const { entries, issues } = await readEntries(good);
  ok(entries.length >= 6, `entries が十分に読めた (${entries.length})`);
  ok(entries.some((e) => e.path.endsWith("Demo.pbip")), "pbip ファイルを含む");
  ok(entries.some((e) => e.path.endsWith("売上.tmdl")), "tmdl ファイルを含む");

  // 2) analyze produces a report with pages/visuals and the inline table.
  const project = await analyzeEntries(entries, issues);
  ok(project.report?.pages?.length === 1, "ページが1つ解析された");
  ok(project.report.pages[0].visuals.length === 1, "ビジュアルが1つ");
  ok((project.dataModel?.loadedTables || []).some((t) => t.rows === 2),
    "埋め込みデータ(2行)が読み込まれた");

  // 3) summarize + trimProject are well-formed.
  const text = summarize(project);
  ok(text.includes("ページ:"), "summary に見出しが含まれる");
  const trimmed = trimProject(project);
  ok(typeof trimmed.entries[0].path === "string" && trimmed.entries[0].text === undefined,
    "trim 後 entries に本文が残っていない");
  const trimmedTable = (trimmed.semantic?.tables || []).find((t) => t.data);
  ok(!trimmedTable || (trimmedTable.data.records === undefined && typeof trimmedTable.data.rows === "number"),
    "trim 後 semantic データは行数に要約されている");

  // 4) validation: good is clean, broken JSON raises an error (exit-code gate).
  ok((project.validation?.errors || 0) === 0, "正常PBIPは検査エラー0");
  const badEntries = await readEntries(bad);
  const badProject = await analyzeEntries(badEntries.entries, badEntries.issues);
  ok((badProject.validation?.errors || 0) > 0, "壊れたPBIPは検査エラー>0");

  // 5) self-contained HTML embeds app.js + data and auto-bootstraps.
  const html = await buildSelfContainedHtml(entries, { title: "smoke" });
  ok(html.includes("__ENTRIES__"), "HTML に埋め込みデータがある");
  ok(html.includes("PBIPViewerParser"), "HTML に app.js が埋め込まれている");
  ok(html.includes("loadEntriesForPreview"), "HTML が自動ブートストラップする");
  ok(!/<script src="https:\/\/[^"]*jszip/i.test(html), "JSZip CDN 行が除去されている");

  // 5b) self-contained HTML carries exactly one (offline) CSP and survives '$' titles.
  ok((html.match(/Content-Security-Policy/g) || []).length === 1, "CSP メタは1つだけ");
  ok(html.includes("default-src 'none'"), "オフライン用CSPが入っている");
  const dollarHtml = await buildSelfContainedHtml(entries, { title: "Q4$&$`<x>" });
  ok(dollarHtml.includes("Q4$&amp;$`&lt;x&gt;"), "タイトルの $ パターンが壊れずエスケープされている");

  // 6) error handling: clear, thrown errors for bad inputs (agent/CLI surface).
  await assertRejects(() => readEntries(path.join(base, "does-not-exist")),
    /パスが見つかりません/, "存在しないパスは明確に失敗する");
  const emptyDir = path.join(base, "empty");
  await fsp.mkdir(emptyDir, { recursive: true });
  await assertRejects(() => readEntries(emptyDir),
    /読み取れるファイル/, "空フォルダは『読み取れるファイルなし』で失敗する");
  await assertRejects(() => readEntries(""),
    /パスが指定されていません/, "空文字パスは明確に失敗する");
  const fakeZip = path.join(base, "broken.zip");
  await fsp.writeFile(fakeZip, "this is not a zip");
  await assertRejects(() => readEntries(fakeZip),
    /zipを展開できません/, "壊れたzipは明確に失敗する");

  // 6b) a non-PBIP folder still loads but warns (doesn't throw if it has files).
  const notPbip = path.join(base, "notpbip");
  await fsp.mkdir(notPbip, { recursive: true });
  await fsp.writeFile(path.join(notPbip, "notes.txt"), "hello");
  const np = await readEntries(notPbip);
  ok(np.issues.some((i) => /PBIPらしき/.test(i.title)), "PBIPらしくないフォルダは警告を出す");

  // 7) lib/model: evaluate DAX against the fixture's embedded data (売上: 100+200).
  ok((await evaluateExpression(project, "SUM(売上[金額])")) === 300, "evaluateExpression: SUM(売上[金額]) = 300");
  ok((await evaluateExpression(project, "[売上合計]")) === 300, "evaluateExpression: メジャー参照 [売上合計] = 300");
  await assertRejects(() => evaluateExpression({ semantic: { tables: [] } }, "1+1"),
    /埋め込みデータ/, "データ無しプロジェクトのDAX評価は明確に失敗する");

  // 8) lib/diff: identical project -> no changes; report contains the measure.
  const same = diffProjects(project, project);
  ok(!same.measures.added.length && !same.measures.removed.length && !same.measures.changed.length, "同一プロジェクトの差分は空");
  const md = buildMarkdownReport(project, "smoke");
  ok(md.includes("# smoke — PBIP レポート") && md.includes("売上合計") && md.includes("```dax"), "Markdownレポートに見出し・メジャー・DAXが含まれる");

  await fsp.rm(base, { recursive: true, force: true });
  console.log(`cli-smoke: ${pass} checks passed`);
}

main().catch((err) => {
  console.error("cli-smoke FAILED:", err);
  process.exit(1);
});
