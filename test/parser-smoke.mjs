import assert from "node:assert/strict";

await import("../app.js");

const { analyzeProject } = globalThis.PBIPViewerParser;

const entries = [
  {
    path: "Sample.pbip",
    text: JSON.stringify({
      version: "1.0",
      artifacts: [
        { report: { path: "Sample.Report" } },
        { semanticModel: { path: "Sample.SemanticModel" } },
      ],
    }),
    size: 120,
  },
  {
    path: "Sample.Report/definition.pbir",
    text: JSON.stringify({
      version: "4.0",
      datasetReference: { byPath: "../Sample.SemanticModel" },
    }),
    size: 96,
  },
  {
    path: "Sample.Report/definition/report.json",
    text: JSON.stringify({ settings: { useStylableVisualContainerHeader: true } }),
    size: 64,
  },
  {
    path: "Sample.Report/definition/pages/pages.json",
    text: JSON.stringify({ activePageName: "ReportSection", pageOrder: ["ReportSection"] }),
    size: 80,
  },
  {
    path: "Sample.Report/definition/pages/ReportSection/page.json",
    text: JSON.stringify({
      name: "ReportSection",
      displayName: "Sales Overview",
      width: 1280,
      height: 720,
    }),
    size: 120,
  },
  {
    path: "Sample.Report/definition/pages/ReportSection/visuals/Visual1/visual.json",
    text: JSON.stringify({
      name: "Visual1",
      position: { x: 40, y: 52, width: 520, height: 280, z: 0 },
      visual: {
        visualType: "clusteredColumnChart",
        query: {
          queryState: {
            Category: {
              projections: [
                {
                  field: {
                    Column: {
                      Expression: { SourceRef: { Entity: "Sales" } },
                      Property: "Region",
                    },
                  },
                },
              ],
            },
            Y: {
              projections: [
                {
                  field: {
                    Measure: {
                      Expression: { SourceRef: { Entity: "Sales" } },
                      Property: "Total Sales",
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
    size: 520,
  },
  {
    path: "Sample.SemanticModel/definition/tables/Sales.tmdl",
    text: [
      "table 'Sales'",
      "  column 'Region'",
      "    dataType: string",
      "  column 'Amount'",
      "    dataType: decimal",
      "  measure 'Total Sales' = SUM('Sales'[Amount])",
    ].join("\n"),
    size: 160,
  },
];

const project = analyzeProject(entries, []);

assert.equal(project.report.pages.length, 1);
assert.equal(project.report.pages[0].displayName, "Sales Overview");
assert.equal(project.report.visuals.length, 1);
assert.equal(project.report.visuals[0].type, "clusteredColumnChart");
assert.ok(project.report.visuals[0].fields.some((field) => field.label === "Sales[Region]"));
assert.ok(project.report.visuals[0].fields.some((field) => field.label === "Sales[Total Sales]"));
assert.equal(project.semantic.tables.length, 1);
assert.equal(project.semantic.tables[0].columns.length, 2);
assert.equal(project.semantic.tables[0].measures.length, 1);

console.log("parser smoke test passed");
