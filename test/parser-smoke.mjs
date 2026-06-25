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

// --- ロール別データバインドの再現 ---
const roles = project.report.visuals[0].roles;
assert.ok(Array.isArray(roles) && roles.length >= 2, "roles should be extracted");
const categoryRole = roles.find((role) => role.role === "Category");
const valueRole = roles.find((role) => role.role === "Y");
assert.ok(categoryRole?.fields.some((field) => field.label === "Sales[Region]"));
assert.ok(valueRole?.fields.some((field) => field.label === "Sales[Total Sales]" && field.kind === "measure"));

// --- テーマ配色の再現(デフォルトパレットへフォールバック) ---
assert.ok(Array.isArray(project.report.theme.dataColors) && project.report.theme.dataColors.length > 0);

console.log("parser smoke test passed");

// --- 書式(タイトル文言・背景色)とテーマファイルの解析 ---
const styledProject = analyzeProject(
  [
    { path: "Styled.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "Styled.Report" } }] }), size: 80 },
    {
      path: "Styled.Report/definition/pages/pages.json",
      text: JSON.stringify({ pageOrder: ["P1"] }),
      size: 40,
    },
    {
      path: "Styled.Report/definition/pages/P1/page.json",
      text: JSON.stringify({ name: "P1", displayName: "Styled", width: 1280, height: 720 }),
      size: 80,
    },
    {
      path: "Styled.Report/definition/pages/P1/visuals/V1/visual.json",
      text: JSON.stringify({
        name: "V1",
        position: { x: 0, y: 0, width: 200, height: 120, z: 0 },
        visual: {
          visualType: "card",
          visualContainerObjects: {
            title: [{ properties: { text: { expr: { Literal: { Value: "'売上合計'" } } }, fontColor: { solid: { color: { expr: { Literal: { Value: "'#FF0000'" } } } } } } }],
            background: [{ properties: { color: { solid: { color: { expr: { Literal: { Value: "'#00FF00'" } } } } } } }],
          },
        },
      }),
      size: 200,
    },
    {
      path: "Styled.Report/StaticResources/SharedResources/BaseThemes/CustomTheme.json",
      text: JSON.stringify({ name: "Custom", dataColors: ["#010203", "#040506"] }),
      size: 80,
    },
  ],
  [],
);

const styledVisual = styledProject.report.visuals[0];
assert.equal(styledVisual.title, "売上合計");
assert.equal(styledVisual.style.title.color, "#FF0000");
assert.equal(styledVisual.style.background.color, "#00FF00");
assert.deepEqual(styledProject.report.theme.dataColors, ["#010203", "#040506"]);
assert.equal(styledProject.report.theme.isDefault, false);

assert.equal(styledVisual.hasExplicitTitle, true, "explicit title object should show title");

console.log("style & theme smoke test passed");

// --- 実プロジェクト型の挙動(タイトル抑制 / shape塗り / displayName) ---
const fidelityProject = analyzeProject(
  [
    { path: "F.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "F.Report" } }] }), size: 40 },
    { path: "F.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "F.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1920, height: 1080 }), size: 60 },
    {
      path: "F.Report/definition/pages/P/visuals/header/visual.json",
      text: JSON.stringify({
        name: "header",
        position: { x: 0, y: 0, width: 1920, height: 84, z: 0 },
        visual: { visualType: "shape", objects: { fill: [{ properties: { fillColor: { solid: { color: { expr: { Literal: { Value: "'#1F5FA6'" } } } } } } }] } },
      }),
      size: 120,
    },
    {
      path: "F.Report/definition/pages/P/visuals/kpi/visual.json",
      text: JSON.stringify({
        name: "kpi",
        position: { x: 40, y: 110, width: 430, height: 120, z: 1 },
        visual: {
          visualType: "cardVisual",
          query: { queryState: { Data: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "案件" } }, Property: "件数" } }, queryRef: "案件.件数", nativeQueryRef: "件数", displayName: "指摘金額の合計(7案件)" }] } } },
        },
      }),
      size: 200,
    },
  ],
  [],
);

const header = fidelityProject.report.pages[0].visuals.find((visual) => visual.id === "header");
const kpi = fidelityProject.report.pages[0].visuals.find((visual) => visual.id === "kpi");
assert.equal(header.style.fill, "#1F5FA6", "shape fill color");
assert.equal(header.hasExplicitTitle, false, "shape has no auto title bar");
assert.equal(kpi.hasExplicitTitle, false, "card has no auto title bar");
assert.equal(kpi.roles.flatMap((role) => role.fields)[0].display, "指摘金額の合計(7案件)", "card label uses displayName");

console.log("fidelity smoke test passed");

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
