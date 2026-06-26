# PBIP Viewer

PBIP Viewer is a static browser app for inspecting Power BI Project files.

It reads PBIP/PBIR project metadata in the browser and renders an approximate
report canvas, visual inventory, file inventory, and semantic model explorer.

Slicers on the canvas are **interactive**: click an item to cross-filter the
other visuals on the page (propagated across table relationships); click again
or use **クリア** to reset.

## Privacy

All processing happens **locally in your browser**. The files you open are
**never uploaded or transmitted** to any server — there is no backend. (The
page itself and the JSZip library load from the web, but your project data
stays on your machine.)

## Supported input

- A PBIP project folder selected with **フォルダを開く**
- A zip archive containing a PBIP project
- Individual `.pbip`, `.pbir`, `.pbism`, `.bim`, `.json`, `.tmdl`, and `.platform` files

For a PBIP project that looks like this, select the **whole project folder**
with **フォルダを開く** (subfolders are read recursively):

```text
Project Folder/
  MyReport.pbip                                  ← project manifest
  MyReport.Report/
    definition.pbir                              ← dataset reference
    definition/report.json
    definition/pages/pages.json
    definition/pages/<page>/page.json            ← each page
    definition/pages/<page>/visuals/<id>/visual.json   ← each visual
    StaticResources/**                           ← theme JSON, images
  MyReport.SemanticModel/
    definition.pbism
    definition/model.tmdl
    definition/tables/*.tmdl                      ← tables / measures
    (or legacy model.bim)
```

## Files it reads

| Purpose | Files |
| --- | --- |
| Pages & layout | `.Report/definition/pages/*/page.json` |
| Visuals & bindings | `.Report/definition/pages/*/visuals/*/visual.json` |
| Dataset reference | `.Report/definition.pbir` |
| Report settings & theme | `.Report/definition/report.json`, `.Report/StaticResources/**` |
| Tables, columns, measures | `.SemanticModel/definition/**/*.tmdl` (or legacy `model.bim`) |
| Images (visuals / wallpaper) | `.png` `.jpg` `.jpeg` `.gif` `.svg` `.webp` `.bmp` under the project |
| Legacy layout | `.Report/report.json` (`sections`/`visualContainers`) |

To reproduce **actual numbers**, the semantic model must embed data in a TMDL
partition via `Table.FromRows(...)`. Models that only reference an external
source render shapes/labels without values.

A built-in DAX engine evaluates measures over that embedded data. Supported
functions include aggregations (`SUM`/`AVERAGE`/`MIN`/`MAX`/`COUNT`/
`DISTINCTCOUNT`/`MEDIAN`…), iterators (`SUMX`/`AVERAGEX`/`RANKX`/
`CONCATENATEX`…), filter/table (`CALCULATE`/`FILTER`/`TOPN`/`ALL`/`VALUES`),
logic (`IF`/`SWITCH`/`AND`/`OR`/`COALESCE`), date/time (`DATE`/`YEAR`/`MONTH`/
`DATEDIFF`/`EOMONTH`/`EDATE`/`WEEKDAY`/`TODAY`…), text (`LEFT`/`MID`/`LEN`/
`SUBSTITUTE`/`FIND`/`FORMAT`…), and math (`ROUND`/`DIVIDE`/`POWER`/`MOD`/
`CEILING`…). It is an approximation, not the full Power BI engine.

After loading, the **検出事項 (Issues)** tab reports a PBIP integrity check
(broken JSON, missing files, references to non-existent tables/columns/measures,
page-order mismatches, etc.) so you can catch projects that would fail to open
in Power BI.

The **モデル (Model)** tab adds static analysis of the semantic model:

- **Unused measures / columns** — anything not reached (transitively) from a
  visual, another used measure, a relationship, or a `sortByColumn`.
- **Measure dependency graph** — each measure lists what it 依存 (depends on)
  and its 参照元 (reverse references).
- **Circular references** — measure cycles (e.g. `A → B → A`) are detected and
  reported as errors, since Power BI refuses to open them.
- **DAX hints** — e.g. suggesting `DIVIDE()` over `/`, or dropping a table
  qualifier on a measure reference.
- **Relationship diagram (ER)** — tables as nodes, relationships as edges with
  cardinality / direction / active state, plus the detail list.
- **RLS roles, calculation groups, incremental refresh policies** — detected
  from TMDL and summarized.
- **Best-practice checks (BPA-style)** — measures without a format string,
  bidirectional cross-filters, inactive relationships, hidden columns used in
  visuals. Surfaced in 検出事項 and the analysis JSON (`bestPractices`).

This is also exposed through the CLI/MCP `analyze` output (`measureUsage` plus
per-measure `used` / `dependsOn` / `referencedBy` / `inCycle`), and circular
references make `pbip-viewer check` exit non-zero.

## Command line (CLI)

The same analyzer that powers the browser app runs in Node (v18+), so you can
inspect a PBIP from a terminal or a script. Input is a **project folder** or a
**`.zip`**.

```bash
npm install            # installs jszip (.zip input) and the MCP SDK

# Human-readable summary (pages / visuals / tables / 検査 / embedded data)
node bin/cli.mjs analyze ./MyReport

# Structured JSON (trimmed; add --raw for full file bodies, --pretty to format)
node bin/cli.mjs analyze ./MyReport --json --pretty
node bin/cli.mjs analyze ./MyReport.zip --json

# Integrity check — prints problems and exits 1 if there are errors (CI gate)
node bin/cli.mjs check ./MyReport && echo "Power BI で開けます"

# Write a self-contained single-file HTML preview (offline; open in a browser)
node bin/cli.mjs html ./MyReport -o preview.html

# Evaluate a DAX expression against the embedded data
node bin/cli.mjs dax ./MyReport "SUM(売上[金額])"
node bin/cli.mjs dax ./MyReport "[件数]" --table 案件

# Diff two PBIPs (pages / visuals / measures / columns / relationships / 検査)
node bin/cli.mjs diff ./before ./after

# Markdown report (overview, measure DAX, issues, relationships)
node bin/cli.mjs report ./MyReport -o report.md
```

`check` exits with code **1** when the project has integrity errors and **0**
otherwise, so it can gate a pipeline that generates PBIP files.

If you `npm link` (or install globally), the `pbip-viewer` command is available
directly: `pbip-viewer analyze ./MyReport`.

## AI agents (MCP server)

An [MCP](https://modelcontextprotocol.io) server exposes the analyzer to AI
agents (Claude etc.), so an agent that generates PBIP files can verify them and
read back the reproduced structure automatically.

Register it with Claude Code:

```bash
claude mcp add pbip-viewer -- node /absolute/path/to/powerbi_viewer/bin/mcp.mjs
```

Or in Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pbip-viewer": {
      "command": "node",
      "args": ["/absolute/path/to/powerbi_viewer/bin/mcp.mjs"]
    }
  }
}
```

Tools provided:

| Tool | Input | Returns |
| --- | --- | --- |
| `analyze_pbip` | `{ path, includeRaw? }` | Structured analysis JSON (pages, visuals, measures, embedded data, validation) |
| `validate_pbip` | `{ path }` | `{ ok, errors, warnings, problems, summary }` — whether it would open in Power BI |
| `render_pbip_html` | `{ path, outPath? }` | Writes a self-contained HTML preview, returns its path |
| `evaluate_dax` | `{ path, expression, table? }` | Evaluates a DAX expression against the embedded data (`SUM`, `CALCULATE`, `RELATED`, `TOTALYTD`, measure refs `[name]`…) |
| `diff_pbip` | `{ pathA, pathB }` | Structural diff of pages/visuals/measures/columns/relationships/validation |
| `report_pbip_markdown` | `{ path, outPath? }` | Markdown report (overview, measure DAX, issues, relationships) |

## Limitations

PBIP projects usually do not contain imported data. This viewer does not run
the Power BI engine, DAX, custom visuals, or Power BI Embedded. The canvas is a
metadata preview of PBIR layout and bindings, not an exact Power BI rendering.

For exact rendering, open the project in Power BI Desktop or publish it to the
Power BI service.
