// Structural diff between two analyzed PBIP projects.

function measureMap(project) {
  const map = new Map();
  for (const t of project?.semantic?.tables || []) {
    for (const m of t.measures || []) {
      map.set(`${t.name}[${m.name}]`, Array.isArray(m.expression) ? m.expression.join("\n") : m.expression || "");
    }
  }
  return map;
}

function columnSet(project) {
  const set = new Set();
  for (const t of project?.semantic?.tables || []) {
    for (const c of t.columns || []) set.add(`${t.name}[${c.name}]`);
  }
  return set;
}

function relSet(project) {
  return new Set(
    (project?.semantic?.relationships || [])
      .filter((r) => r.fromTable && r.toTable)
      .map((r) => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`),
  );
}

function pageMap(project) {
  // 安定した一意キー(id/フォルダ名)で集計。表示名は重複しうるため不可。
  const map = new Map();
  for (const p of project?.report?.pages || []) {
    map.set(p.id || p.displayName, { label: p.displayName || p.id, count: (p.visuals || []).length });
  }
  return map;
}

const added = (a, b) => [...b].filter((x) => !a.has(x));

export function diffProjects(a, b) {
  const ma = measureMap(a);
  const mb = measureMap(b);
  const changed = [];
  for (const [key, exprA] of ma) {
    if (mb.has(key) && mb.get(key) !== exprA) changed.push({ measure: key, from: exprA, to: mb.get(key) });
  }
  const ca = columnSet(a);
  const cb = columnSet(b);
  const ra = relSet(a);
  const rb = relSet(b);
  const pa = pageMap(a);
  const pb = pageMap(b);
  const pagesChanged = [];
  for (const [id, va] of pa) {
    if (pb.has(id) && pb.get(id).count !== va.count) pagesChanged.push({ page: va.label, fromVisuals: va.count, toVisuals: pb.get(id).count });
  }
  const labelOf = (m) => (id) => m.get(id)?.label ?? id;
  const addedPages = added(new Set(pa.keys()), new Set(pb.keys())).map(labelOf(pb));
  const removedPages = added(new Set(pb.keys()), new Set(pa.keys())).map(labelOf(pa));

  return {
    pages: { added: addedPages, removed: removedPages, changedVisualCount: pagesChanged },
    measures: { added: added(new Set(ma.keys()), new Set(mb.keys())), removed: added(new Set(mb.keys()), new Set(ma.keys())), changed },
    columns: { added: added(ca, cb), removed: added(cb, ca) },
    relationships: { added: added(ra, rb), removed: added(rb, ra) },
    validation: {
      errors: { from: a?.validation?.errors || 0, to: b?.validation?.errors || 0 },
      warnings: { from: a?.validation?.warnings || 0, to: b?.validation?.warnings || 0 },
    },
  };
}

export function formatDiff(diff, labelA = "A", labelB = "B") {
  const lines = [`差分: ${labelA} → ${labelB}`];
  const section = (title, addedList, removedList) => {
    if (!addedList.length && !removedList.length) return;
    lines.push(`\n[${title}]`);
    for (const x of addedList) lines.push(`  + ${x}`);
    for (const x of removedList) lines.push(`  - ${x}`);
  };
  section("ページ", diff.pages.added, diff.pages.removed);
  for (const p of diff.pages.changedVisualCount) lines.push(`  ~ ${p.page}: ビジュアル ${p.fromVisuals} → ${p.toVisuals}`);
  section("メジャー", diff.measures.added, diff.measures.removed);
  for (const m of diff.measures.changed) lines.push(`  ~ ${m.measure} のDAXが変更されました`);
  section("列", diff.columns.added, diff.columns.removed);
  section("リレーション", diff.relationships.added, diff.relationships.removed);
  const v = diff.validation;
  if (v.errors.from !== v.errors.to || v.warnings.from !== v.warnings.to) {
    lines.push(`\n[検査] エラー ${v.errors.from}→${v.errors.to} / 警告 ${v.warnings.from}→${v.warnings.to}`);
  }
  if (lines.length === 1) lines.push("（差分はありません）");
  return lines.join("\n");
}
