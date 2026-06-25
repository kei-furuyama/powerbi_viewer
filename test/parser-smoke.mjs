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

const legacyReportConfig = {
  name: "legacy_donut",
  layouts: [
    {
      id: 0,
      position: { x: 20, y: 30, z: 0, width: 240, height: 180, tabOrder: 0 },
    },
  ],
  singleVisual: {
    visualType: "donutChart",
    prototypeQuery: {
      Version: 2,
      From: [{ Name: "s", Entity: "Status", Type: 0 }],
      Select: [
        {
          Column: {
            Expression: { SourceRef: { Source: "s" } },
            Property: "Label",
          },
          Name: "s.Label",
        },
        {
          Measure: {
            Expression: { SourceRef: { Source: "s" } },
            Property: "Done Count",
          },
          Name: "s.Done Count",
        },
      ],
    },
  },
};

const legacyProject = analyzeProject(
  [
    {
      path: "Legacy.pbip",
      text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "Legacy.Report" } }] }),
      size: 80,
    },
    {
      path: "Legacy.Report/report.json",
      text: JSON.stringify({
        sections: [
          {
            name: "ReportSection",
            displayName: "Legacy Page",
            width: 1920,
            height: 1080,
            visualContainers: [
              {
                config: JSON.stringify(legacyReportConfig),
                filters: "[]",
                x: 20,
                y: 30,
                z: 0,
                width: 240,
                height: 180,
              },
            ],
          },
        ],
      }),
      size: 640,
    },
    {
      path: "Legacy.SemanticModel/model.bim",
      text: JSON.stringify({
        model: {
          tables: [
            {
              name: "Status",
              columns: [{ name: "Label", dataType: "string" }],
              measures: [{ name: "Done Count", expression: "COUNTROWS(Status)" }],
            },
          ],
        },
      }),
      size: 240,
    },
  ],
  [],
);

assert.equal(legacyProject.report.pages.length, 1);
assert.equal(legacyProject.report.pages[0].displayName, "Legacy Page");
assert.equal(legacyProject.report.visuals.length, 1);
assert.equal(legacyProject.report.visuals[0].type, "donutChart");
assert.ok(legacyProject.report.visuals[0].fields.some((field) => field.label === "Status[Label]"));
assert.ok(legacyProject.report.visuals[0].fields.some((field) => field.label === "Status[Done Count]"));
assert.equal(legacyProject.semantic.tables.length, 1);
assert.equal(legacyProject.semantic.tables[0].name, "Status");

console.log("legacy parser smoke test passed");
