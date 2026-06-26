# CLAUDE.md

PBIP Viewer — a static, client-side viewer for **Power BI Project (PBIP)** files.
It parses PBIP/PBIR metadata + TMDL semantic models (with data embedded in
`Table.FromRows` partitions), evaluates a subset of DAX over that data, and
renders an approximate report. Same engine also runs from a CLI and an MCP
server. Deployed to GitHub Pages: https://kei-furuyama.github.io/powerbi_viewer/

## Layout
- `app.js` — the whole browser app + parser + DAX engine + renderer, as **one
  IIFE** (~5300 lines). Exposes `globalThis.PBIPViewerParser = { analyzeProject,
  parseTmdl, evaluateDax, extractInlineData, loadEntriesForPreview }`.
- `index.html` / `styles.css` — browser shell (loads `app.js` + vendored
  `jszip.min.js` via `<script>`, not modules).
- `lib/*.mjs` — Node-only ESM helpers (read-entries, analyze, build-html, model,
  diff, report). These `import('../app.js')` and read `globalThis.PBIPViewerParser`.
- `bin/cli.mjs` (`pbip-viewer`) and `bin/mcp.mjs` (`pbip-viewer-mcp`).
- `test/parser-smoke.mjs` (in-process, exercises `app.js` exports) and
  `test/cli-smoke.mjs` (lib/CLI). Run both with `npm test`.
- Real sample projects live at `/Users/kei/Git/make_powerbi/{kensa,26,powerbi,kensa 2}`.

## Hard invariants — do not break these
- **`analyzeProject(entries, issues)` is DOM-free** and must stay so (the CLI/MCP
  import `app.js` in Node). `window`/`document`/`JSZip` are `typeof`-guarded;
  rendering (`renderCanvas` etc.) only runs when `typeof document !== "undefined"`.
- **`app.js` must stay a single non-module file.** The self-contained HTML
  (`bin/cli.mjs html`, `lib/build-html.mjs`) inlines `app.js` verbatim as one
  `<script>`. No `import`/`export` in `app.js`, and **no bundler** (zero-build
  static site). lib modules may be split freely; `app.js` may not.
- **No `eval` / `new Function` / network in `app.js`.** The DAX engine is a hand
  written tokenizer→parser→evaluator. CSP on the live page is `script-src 'self'`
  (self-contained HTML uses `script-src 'unsafe-inline'`); both block `eval` and
  external fetches. The product promise is **local-only, no upload, no beacons**.
- **Privacy:** never add a network call to the load/analyze/render path. Remote
  image URLs in a PBIP are intentionally rendered as placeholders (CSP blocks them).
- Entries shape: `[{ path, text, size, isImage?, dataUrl? }]`. Text exts:
  pbip/pbir/pbism/bim/json/tmdl/platform/txt. Images → base64 data URLs.

## DAX engine (app.js)
- Values are JS number/string/boolean/null, plus **`Date`** (serial = days since
  `DAX_EPOCH` 1899-12-30, UTC). `toNum`/`compareValues`/`truthy` handle `Date`.
- Eval context `ctx = { table, model, rows, row, vars, stack, relationships,
  activeRel }`. `model` is the `byName` Map with `.relationships` attached by
  `buildDataModel`.
- **Cross-table correctness:** column refs honor `node.table` (`evalDaxColRef`);
  aggregations iterate the qualified column's table; `CALCULATE` filters propagate
  dimension predicates to the fact table via the relationship key (`applyCalcFilter`
  + `findRelationship`/`relatedRow`). Iterators/`FILTER`/`TOPN` switch `ctx.table`
  via `tableOfArg`. Time-intelligence funnels through `contextDateValues` /
  `dateRowsInRange` which bridge a separate date table via `dateFactBridge`.
- Compiled ASTs are cached in `__daxCache` (keyed by expression string); ASTs are
  read-only during eval. `resolveColumn` memoizes a normalized→actual column map
  on each table (`__colMap`, non-enumerable so it doesn't serialize).
- Known limitation (deferred): cross-filter does not traverse multi-hop
  (snowflake) relationships — single-hop only (covers star schemas).

## Analysis surface (`analyzeProject` return)
`{ report, semantic, dataModel, measureUsage, bestPractices, validation, issues, … }`.
`semantic` also carries `relationships`, `roles` (RLS), `calculationGroups`,
`refreshPolicies`. `measureUsage` = `{ unused, unusedColumns, cycles, lint }`
(dependency graph, transitive-unused, Tarjan cycle detection). `bestPractices` =
BPA-style findings. Circular measure refs are folded into `validation` as errors,
so `pbip-viewer check` exits 1 on them.

## Workflow conventions
- **Verify before claiming done:** `npm test` green; render real projects via the
  self-contained HTML (`node bin/cli.mjs html <proj> -o /tmp/x.html`) and check in
  a browser (chrome-devtools MCP) for visual correctness **and zero console
  errors**; confirm known numbers are unchanged (kensa `COUNTROWS(案件)`=11,
  26 `SUM('都道府県別'[完了数])`=1161).
- **Ship in small increments:** implement → test/verify → commit → push `main`.
  CI (`.github/workflows/pages.yml`) gates deploy on `npm test`, then ships only
  `index.html app.js styles.css jszip.min.js` to Pages via `_site/`.
- Code comments are in **Japanese**; match the surrounding style. End commit
  messages with the Co-Authored-By trailer.
- For large reviews/audits the user opts into multi-agent workflows ("ultracode" /
  "最高のチームで" / "複数エージェントでレビュー"); findings are always
  adversarially verified before fixing.

## Commands
- `npm test` — parser + CLI smoke tests (CI uses this as the deploy gate).
- `node bin/cli.mjs <analyze|check|html|dax|diff|report> <path> …`
- `node bin/mcp.mjs` — MCP stdio server (`claude mcp add pbip-viewer -- node <abs>/bin/mcp.mjs`).
