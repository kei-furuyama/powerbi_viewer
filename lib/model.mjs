// Reconstruct a DAX-evaluable model from an analyzed project and evaluate
// arbitrary DAX expressions against the embedded (Table.FromRows) data.
import { getParser } from "./analyze.mjs";

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[\s_'"\[\]]+/g, "");
}

// Build the model map consumed by PBIPViewerParser.evaluateDax, with
// relationships attached (mirrors app.js buildDataModel).
export function buildEvalModel(project) {
  const tables = project?.semantic?.tables || [];
  const byName = new Map();
  const primary = [];
  for (const table of tables) {
    if (!table.data?.records?.length) continue;
    const measures = new Map((table.measures || []).map((m) => [m.name, m]));
    const model = { name: table.name, columns: table.data.columns, records: table.data.records, measures };
    byName.set(table.name, model);
    byName.set(normalize(table.name), model);
    primary.push(model);
  }
  byName.relationships = (project?.semantic?.relationships || [])
    .filter((r) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
    .map((r) => ({
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      isActive: r.isActive !== false,
      toCardinality: r.toCardinality || "",
    }));
  return { byName, primary };
}

// Evaluate a DAX expression against the project's embedded data.
// tableName selects the row/filter-context table (defaults to the first table
// that has measures, else the first table with data).
export async function evaluateExpression(project, expression, tableName) {
  const parser = await getParser();
  if (!parser.evaluateDax) throw new Error("evaluateDax を利用できません");
  const { byName, primary } = buildEvalModel(project);
  if (!primary.length) {
    throw new Error("埋め込みデータ(Table.FromRows)を持つテーブルがありません。DAX評価には実データが必要です。");
  }
  let table;
  if (tableName) {
    table = byName.get(tableName) || byName.get(normalize(tableName));
    if (!table) throw new Error(`テーブルが見つかりません: ${tableName}（候補: ${primary.map((t) => t.name).join(", ")}）`);
  } else {
    table = primary.find((t) => t.measures.size) || primary[0];
  }
  return parser.evaluateDax(expression, table.records, table, byName);
}
