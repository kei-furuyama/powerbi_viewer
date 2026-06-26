// Render an analyzed PBIP project as a human/agent-friendly Markdown report.

function esc(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

export function buildMarkdownReport(project, name = "PBIP") {
  const r = project.report || {};
  const v = project.validation || { errors: 0, warnings: 0 };
  const tables = project.semantic?.tables || [];
  const measureCount = tables.reduce((n, t) => n + (t.measures?.length || 0), 0);
  const out = [];

  out.push(`# ${name} — PBIP レポート`, "");
  const check = v.errors > 0 ? `NG（エラー ${v.errors} / 警告 ${v.warnings}）` : v.warnings > 0 ? `△（警告 ${v.warnings}）` : "OK";
  out.push("## 概要", "");
  out.push(`- ページ: ${r.pages?.length || 0} / ビジュアル: ${r.visuals?.length || 0} / テーブル: ${tables.length} / メジャー: ${measureCount}`);
  out.push(`- 検査: ${check}`);
  const loaded = project.dataModel?.loadedTables || [];
  if (loaded.length) out.push(`- 埋め込みデータ: ${loaded.map((t) => `${t.name}(${t.rows}行)`).join(", ")}`);
  const mu = project.measureUsage || {};
  if (mu.unused) out.push(`- 未使用メジャー: ${mu.unused}`);
  if (mu.unusedColumns) out.push(`- 未使用列: ${mu.unusedColumns}`);
  if (mu.cycles?.length) out.push(`- 循環参照: ${mu.cycles.length}`);
  out.push("");

  const problems = (project.issues || []).filter((i) => i.level === "error" || i.level === "warning");
  if (problems.length) {
    out.push("## 検出事項", "");
    for (const p of problems) out.push(`- **[${String(p.level).toUpperCase()}]** ${esc(p.title)}: ${esc(p.detail || "")}`);
    out.push("");
  }

  out.push("## ページ", "");
  for (const page of r.pages || []) {
    const visuals = page.visuals || [];
    out.push(`### ${esc(page.displayName)}  \`${Math.round(page.width)}×${Math.round(page.height)}\` / ${visuals.length} visuals`, "");
    for (const vis of visuals) {
      const roles = (vis.roles || []).map((role) => `${role.role}=${(role.fields || []).map((f) => f.label).join(",")}`).join(" ");
      out.push(`- ${esc(vis.typeLabel)} "${esc(vis.title)}"${roles ? ` — ${esc(roles)}` : ""}`);
    }
    out.push("");
  }

  if (measureCount) {
    out.push("## メジャー", "");
    for (const t of tables) {
      if (!t.measures?.length) continue;
      out.push(`### ${esc(t.name)}`, "");
      for (const m of t.measures) {
        const tags = [m.formatString ? `\`${esc(m.formatString)}\`` : "", m.used === false ? "（未使用）" : "", m.inCycle ? "（循環）" : ""].filter(Boolean).join(" ");
        out.push(`- **${esc(m.name)}** ${tags}`.trimEnd());
        const expr = Array.isArray(m.expression) ? m.expression.join("\n") : m.expression || "";
        if (expr) {
          // 式中のバッククォート連続より長いフェンスを使い、コードブロックが途中で閉じないようにする
          const longest = Math.max(0, ...(expr.match(/`+/g) || []).map((s) => s.length));
          const fence = "`".repeat(Math.max(3, longest + 1));
          out.push("", `  ${fence}dax`, ...expr.split("\n").map((l) => `  ${l}`), `  ${fence}`);
        }
      }
      out.push("");
    }
  }

  const rels = (project.semantic?.relationships || []).filter((rel) => rel.fromTable && rel.toTable);
  if (rels.length) {
    out.push("## リレーション", "");
    for (const rel of rels) {
      const arrow = /both/i.test(rel.crossFilter || "") ? "↔" : "→";
      out.push(`- ${esc(rel.fromTable)}[${esc(rel.fromColumn)}] ${arrow} ${esc(rel.toTable)}[${esc(rel.toColumn)}]${rel.isActive === false ? " （非アクティブ）" : ""}`);
    }
    out.push("");
  }

  return out.join("\n");
}
