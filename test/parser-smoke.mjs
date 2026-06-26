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
    {
      path: "F.Report/definition/pages/P/visuals/title/visual.json",
      text: JSON.stringify({
        name: "title",
        position: { x: 40, y: 18, width: 1300, height: 50, z: 2 },
        visual: {
          visualType: "textbox",
          objects: {
            general: [{ properties: { paragraphs: [{ textRuns: [{ value: "ダッシュボード", textStyle: { fontWeight: "bold", fontSize: "22pt", color: "#FFFFFF" } }] }] } }],
          },
        },
      }),
      size: 200,
    },
  ],
  [],
);

const header = fidelityProject.report.pages[0].visuals.find((visual) => visual.id === "header");
const kpi = fidelityProject.report.pages[0].visuals.find((visual) => visual.id === "kpi");
const titleTb = fidelityProject.report.pages[0].visuals.find((visual) => visual.id === "title");
assert.ok(titleTb.paragraphs.length >= 1, "textbox paragraphs extracted");
const run = titleTb.paragraphs[0].runs[0];
assert.equal(run.text, "ダッシュボード", "textbox run text");
assert.equal(run.color, "#FFFFFF", "textbox run color from textStyle");
assert.equal(run.sizePt, 22, "textbox run font size (pt)");
assert.equal(run.bold, true, "textbox run bold");
assert.equal(header.style.fill, "#1F5FA6", "shape fill color");
assert.equal(header.hasExplicitTitle, false, "shape has no auto title bar");
assert.equal(kpi.hasExplicitTitle, false, "card has no auto title bar");
assert.equal(kpi.roles.flatMap((role) => role.fields)[0].display, "指摘金額の合計(7案件)", "card label uses displayName");

console.log("fidelity smoke test passed");

// --- TMDLインラインデータからの測定値評価 ---
const dataProject = analyzeProject(
  [
    { path: "D.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "D.Report" } }] }), size: 40 },
    { path: "D.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "D.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    {
      path: "D.Report/definition/pages/P/visuals/card/visual.json",
      text: JSON.stringify({
        name: "card",
        position: { x: 0, y: 0, width: 200, height: 120, z: 0 },
        visual: { visualType: "cardVisual", query: { queryState: { Data: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "案件" } }, Property: "指摘金額計" } }, queryRef: "案件.指摘金額計", nativeQueryRef: "指摘金額計" }] } } } },
      }),
      size: 120,
    },
    {
      path: "D.Report/definition/pages/P/visuals/bar/visual.json",
      text: JSON.stringify({
        name: "bar",
        position: { x: 0, y: 130, width: 400, height: 240, z: 1 },
        visual: {
          visualType: "barChart",
          query: { queryState: {
            Category: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "案件" } }, Property: "区分" } }, queryRef: "案件.区分", nativeQueryRef: "区分" }] },
            Y: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "案件" } }, Property: "件数" } }, queryRef: "案件.件数", nativeQueryRef: "件数" }] },
          } },
        },
      }),
      size: 200,
    },
    {
      path: "D.SemanticModel/definition/tables/案件.tmdl",
      text: [
        "table 案件",
        "\tmeasure 件数 = COUNTROWS('案件')",
        "\t\tformatString: #,0\"件\"",
        "\tmeasure 指摘金額計 = CALCULATE(SUM('案件'[金額億円]), '案件'[金額種別] = \"指摘金額\")",
        "\t\tformatString: #,0.0\"億円\"",
        "\tmeasure 未使用メジャー = SUM('案件'[金額億円]) * 2",
        "\t\tformatString: #,0.0",
        "\tcolumn 区分",
        "\t\tdataType: string",
        "\tcolumn 金額億円",
        "\t\tdataType: double",
        "\tcolumn 金額種別",
        "\t\tdataType: string",
        "\tpartition 案件 = m",
        "\t\tmode: import",
        "\t\tsource =",
        "\t\t\tlet",
        "\t\t\t\tSource = Table.FromRows(",
        "\t\t\t\t\t{",
        "\t\t\t\t\t\t{\"A\", 10.5, \"指摘金額\"},",
        "\t\t\t\t\t\t{\"A\", 5.5, \"指摘金額\"},",
        "\t\t\t\t\t\t{\"B\", 100, \"背景金額\"}",
        "\t\t\t\t\t},",
        "\t\t\t\t\ttype table [区分 = text, 金額億円 = number, 金額種別 = text]",
        "\t\t\t\t)",
        "\t\t\tin",
        "\t\t\t\tSource",
      ].join("\n"),
      size: 400,
    },
  ],
  [],
);

const dataTable = dataProject.semantic.tables.find((table) => table.name === "案件");
assert.ok(dataTable?.data?.records?.length === 3, "inline data rows parsed");
assert.equal(dataProject.dataModel.loadedTables[0].rows, 3);

const cardVisual = dataProject.report.pages[0].visuals.find((visual) => visual.id === "card");
assert.equal(cardVisual.data.kind, "card");
assert.equal(cardVisual.data.text, "16.0億円", "CALCULATE(SUM) filtered measure evaluated and formatted");

const barVisual = dataProject.report.pages[0].visuals.find((visual) => visual.id === "bar");
assert.equal(barVisual.data.kind, "category");
const groupA = barVisual.data.series.find((point) => point.label === "A");
const groupB = barVisual.data.series.find((point) => point.label === "B");
assert.equal(groupA.value, 2, "COUNTROWS per category group A");
assert.equal(groupB.value, 1, "COUNTROWS per category group B");

// --- 未使用メジャー検出 ---
const measuresByName = Object.fromEntries(dataTable.measures.map((measure) => [measure.name, measure]));
assert.equal(measuresByName["件数"].used, true, "件数 is bound to the bar visual");
assert.equal(measuresByName["指摘金額計"].used, true, "指摘金額計 is bound to the card visual");
assert.equal(measuresByName["未使用メジャー"].used, false, "未使用メジャー is referenced nowhere");
assert.equal(dataProject.measureUsage.unused, 1, "one unused measure detected");

console.log("inline-data measure smoke test passed");

// --- DAXエンジンの対応度 ---
const { evaluateDax } = globalThis.PBIPViewerParser;
const salesTable = {
  name: "Sales",
  columns: [{ name: "数量" }, { name: "単価" }, { name: "地域" }, { name: "区分" }],
  records: [
    { 数量: 2, 単価: 100, 地域: "東", 区分: "A" },
    { 数量: 3, 単価: 200, 地域: "西", 区分: "A" },
    { 数量: 5, 単価: 50, 地域: "東", 区分: "B" },
  ],
  measures: new Map(),
};
salesTable.measures.set("合計金額", { name: "合計金額", expression: "SUMX('Sales', 'Sales'[数量] * 'Sales'[単価])" });
salesTable.measures.set("件数", { name: "件数", expression: "COUNTROWS('Sales')" });
const model = new Map([["Sales", salesTable]]);
const evalIn = (expr) => evaluateDax(expr, salesTable.records, salesTable, model);

assert.equal(evalIn("SUM('Sales'[数量])"), 10, "SUM");
assert.equal(evalIn("SUMX('Sales', 'Sales'[数量] * 'Sales'[単価])"), 200 + 600 + 250, "SUMX iterator with arithmetic");
assert.equal(evalIn("AVERAGE('Sales'[単価])"), 350 / 3, "AVERAGE");
assert.equal(evalIn("DISTINCTCOUNT('Sales'[地域])"), 2, "DISTINCTCOUNT");
assert.equal(evalIn("CALCULATE(SUM('Sales'[数量]), 'Sales'[区分] = \"A\")"), 5, "CALCULATE simple filter");
assert.equal(evalIn("CALCULATE(SUM('Sales'[数量]), FILTER('Sales', 'Sales'[単価] >= 100))"), 5, "CALCULATE + FILTER");
assert.equal(evalIn("CALCULATE(COUNTROWS('Sales'), 'Sales'[区分] = \"A\" && 'Sales'[地域] = \"東\")"), 1, "CALCULATE && predicate");
assert.equal(evalIn("DIVIDE(SUM('Sales'[数量]), COUNTROWS('Sales'))"), 10 / 3, "DIVIDE");
assert.equal(evalIn("DIVIDE(1, 0, -1)"), -1, "DIVIDE by zero alternate");
assert.equal(evalIn("[合計金額] / [件数]"), 1050 / 3, "measure references + arithmetic");
assert.equal(evalIn("VAR x = SUM('Sales'[数量]) RETURN x * 2"), 20, "VAR/RETURN");
assert.equal(evalIn("IF(SUM('Sales'[数量]) > 5, \"多\", \"少\")"), "多", "IF");
assert.equal(evalIn("ROUND(DIVIDE(10, 3), 2)"), 3.33, "ROUND");

console.log("dax engine smoke test passed");

// --- ビジュアルフィルタ + リレーション ---
const relProject = analyzeProject(
  [
    { path: "R.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "R.Report" } }] }), size: 40 },
    { path: "R.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "R.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    {
      path: "R.Report/definition/pages/P/visuals/c/visual.json",
      text: JSON.stringify({
        name: "c",
        position: { x: 0, y: 0, width: 200, height: 120, z: 0 },
        filterConfig: {
          filters: [
            {
              name: "f1",
              field: { Column: { Expression: { SourceRef: { Entity: "売上" } }, Property: "地域" } },
              filter: { Where: [{ Condition: { In: { Expressions: [{ Column: { Property: "地域" } }], Values: [[{ Literal: { Value: "'東'" } }]] } } }] },
            },
          ],
        },
        visual: { visualType: "cardVisual", query: { queryState: { Data: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "売上" } }, Property: "合計" } }, queryRef: "売上.合計", nativeQueryRef: "合計" }] } } } },
      }),
      size: 200,
    },
    {
      path: "R.SemanticModel/definition/tables/売上.tmdl",
      text: [
        "table 売上",
        "\tmeasure 合計 = SUM('売上'[金額])",
        "\tcolumn 地域",
        "\t\tdataType: string",
        "\tcolumn 金額",
        "\t\tdataType: int64",
        "\tpartition 売上 = m",
        "\t\tsource =",
        "\t\t\tlet Source = Table.FromRows({ {\"東\", 100}, {\"東\", 50}, {\"西\", 999} }, type table [地域 = text, 金額 = Int64.Type]) in Source",
      ].join("\n"),
      size: 300,
    },
    {
      path: "R.SemanticModel/definition/relationships.tmdl",
      text: [
        "relationship rel1",
        "\tfromColumn: 売上.地域",
        "\ttoColumn: '地域マスタ'.地域",
        "\ttoCardinality: one",
        "\tcrossFilteringBehavior: bothDirections",
      ].join("\n"),
      size: 160,
    },
  ],
  [],
);

// ビジュアルフィルタ(地域=東)で合計=150になる(西の999は除外)
const filteredCard = relProject.report.pages[0].visuals.find((visual) => visual.id === "c");
assert.equal(filteredCard.filters.length, 1, "visual filter parsed");
assert.equal(filteredCard.data.text, "150", "measure respects visual-level filter");

// リレーション解析
const rel = relProject.semantic.relationships.find((relationship) => relationship.name === "rel1");
assert.ok(rel, "relationship parsed");
assert.equal(rel.fromTable, "売上");
assert.equal(rel.fromColumn, "地域");
assert.equal(rel.toTable, "地域マスタ");
assert.equal(rel.toColumn, "地域");
assert.equal(rel.crossFilter, "bothDirections");

console.log("filter & relationship smoke test passed");

// --- 凡例(legend)のON/OFF・位置 ---
function donutVisual(name, legendObj) {
  return {
    path: `L.Report/definition/pages/P/visuals/${name}/visual.json`,
    text: JSON.stringify({
      name,
      position: { x: 0, y: 0, width: 300, height: 300, z: 0 },
      visual: {
        visualType: "donutChart",
        objects: legendObj ? { legend: [{ properties: legendObj }] } : {},
        query: { queryState: {
          Category: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: "k" } }, queryRef: "T.k", nativeQueryRef: "k" }] },
          Y: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: "m" } }, queryRef: "T.m", nativeQueryRef: "m" }] },
        } },
      },
    }),
    size: 200,
  };
}

const legendProject = analyzeProject(
  [
    { path: "L.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "L.Report" } }] }), size: 40 },
    { path: "L.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "L.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    donutVisual("donOff", { show: { expr: { Literal: { Value: "false" } } } }),
    donutVisual("donBottom", { show: { expr: { Literal: { Value: "true" } } }, position: { expr: { Literal: { Value: "'BottomCenter'" } } } }),
    donutVisual("donDefault", null),
  ],
  [],
);

const pageVisuals = legendProject.report.pages[0].visuals;
const off = pageVisuals.find((v) => v.id === "donOff");
const bottom = pageVisuals.find((v) => v.id === "donBottom");
const def = pageVisuals.find((v) => v.id === "donDefault");
assert.equal(off.style.legend.show, false, "legend show:false respected");
assert.equal(bottom.style.legend.show, true, "legend show:true");
assert.equal(bottom.style.legend.position, "bottom", "legend position parsed");
assert.equal(def.style.legend.show, true, "legend defaults on when unspecified");

console.log("legend smoke test passed");

// --- PBIP整合性チェック ---
assert.equal(project.validation.errors, 0, "valid sample project passes validation");

const brokenProject = analyzeProject(
  [
    { path: "B.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "B.Report" } }] }), size: 40 },
    { path: "B.Report/definition.pbir", text: JSON.stringify({ version: "4.0", datasetReference: { byPath: "../B.SemanticModel" } }), size: 60 },
    { path: "B.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P", "GHOST"] }), size: 40 },
    { path: "B.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    { path: "B.Report/definition/pages/P/visuals/v1/visual.json", text: '{ "name": "v1", "visual": { "visualType": "card", }, }', size: 60 },
    {
      path: "B.Report/definition/pages/P/visuals/v2/visual.json",
      text: JSON.stringify({
        name: "v2",
        position: { x: 0, y: 0, width: 200, height: 120, z: 0 },
        visual: { visualType: "cardVisual", query: { queryState: { Data: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "案件" } }, Property: "存在しないメジャー" } }, queryRef: "案件.存在しないメジャー", nativeQueryRef: "x" }] } } } },
      }),
      size: 200,
    },
    { path: "B.SemanticModel/definition/tables/案件.tmdl", text: ["table 案件", "\tmeasure 件数 = COUNTROWS('案件')", "\tcolumn 区分", "\t\tdataType: string"].join("\n"), size: 120 },
  ],
  [],
);

assert.ok(brokenProject.validation.errors >= 3, "broken project flags multiple errors");
const titles = brokenProject.validation.problems.map((p) => p.title);
assert.ok(titles.includes("JSONが壊れています"), "detects malformed JSON");
assert.ok(titles.includes("pageOrderが実在しないページを参照"), "detects pageOrder mismatch");
assert.ok(titles.includes("存在しない列/メジャーを参照"), "detects missing measure reference");

console.log("validation smoke test passed");

// --- 複数系列(B) ---
const msTmdl = [
  "table T",
  "\tmeasure m1 = SUM('T'[v1])",
  "\tmeasure m2 = SUM('T'[v2])",
  "\tcolumn k", "\t\tdataType: string",
  "\tcolumn s", "\t\tdataType: string",
  "\tcolumn v1", "\t\tdataType: int64",
  "\tcolumn v2", "\t\tdataType: int64",
  "\tpartition T = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"A\",\"X\",30,12},{\"A\",\"Y\",20,8},{\"B\",\"X\",25,18},{\"B\",\"Y\",15,6} }, type table [k=text, s=text, v1=Int64.Type, v2=Int64.Type]) in Source",
].join("\n");
const mField = (p) => ({ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const cField = (p) => ({ field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const msVis = (name, vtype, qs) => ({ path: `M.Report/definition/pages/P/visuals/${name}/visual.json`, text: JSON.stringify({ name, position: { x: 0, y: 0, width: 400, height: 240, z: 0 }, visual: { visualType: vtype, query: { queryState: qs } } }), size: 200 });
const msProject = analyzeProject(
  [
    { path: "M.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "M.Report" } }] }), size: 40 },
    { path: "M.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "M.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    msVis("clust", "clusteredColumnChart", { Category: { projections: [cField("k")] }, Y: { projections: [mField("m1"), mField("m2")] } }),
    msVis("stack", "stackedColumnChart", { Category: { projections: [cField("k")] }, Series: { projections: [cField("s")] }, Y: { projections: [mField("m1")] } }),
    { path: "M.SemanticModel/definition/tables/T.tmdl", text: msTmdl, size: 400 },
  ],
  [],
);
const clust = msProject.report.pages[0].visuals.find((v) => v.id === "clust");
assert.equal(clust.data.multi, true, "two measures => multi-series");
assert.equal(clust.data.seriesList.length, 2, "two series");
assert.equal(clust.data.stacked, false, "clustered not stacked");
assert.deepEqual(clust.data.categories, ["A", "B"], "categories");
// A: m1=SUM(30,20)=50, B: m1=SUM(25,15)=40
assert.deepEqual(clust.data.seriesList[0].values, [50, 40], "series m1 values");
const stack = msProject.report.pages[0].visuals.find((v) => v.id === "stack");
assert.equal(stack.data.multi, true, "series pivot => multi");
assert.equal(stack.data.stacked, true, "stacked detected");
assert.deepEqual(stack.data.seriesList.map((s) => s.name).sort(), ["X", "Y"], "series from pivot");

console.log("multi-series smoke test passed");

// --- テーブル書式・合計(C) ---
const tableProject = analyzeProject(
  [
    { path: "TB.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "TB.Report" } }] }), size: 40 },
    { path: "TB.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "TB.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    {
      path: "TB.Report/definition/pages/P/visuals/t/visual.json",
      text: JSON.stringify({
        name: "t",
        position: { x: 0, y: 0, width: 500, height: 300, z: 0 },
        visual: {
          visualType: "tableEx",
          objects: {
            columnHeaders: [{ properties: { fontColor: { solid: { color: { expr: { Literal: { Value: "'#FFFFFF'" } } } } }, backColor: { solid: { color: { expr: { Literal: { Value: "'#1F5FA6'" } } } } }, bold: { expr: { Literal: { Value: "true" } } } } }],
            values: [{ properties: { fontColorPrimary: { solid: { color: { expr: { Literal: { Value: "'#252423'" } } } } } } }],
            total: [{ properties: { show: { expr: { Literal: { Value: "true" } } } } }],
          },
          query: { queryState: { Values: { projections: [
            { field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: "k" } }, queryRef: "T.k", nativeQueryRef: "k" },
            { field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: "v" } }, queryRef: "T.v", nativeQueryRef: "v" },
          ] } } },
        },
      }),
      size: 300,
    },
    { path: "TB.SemanticModel/definition/tables/T.tmdl", text: ["table T", "\tcolumn k", "\t\tdataType: string", "\tcolumn v", "\t\tdataType: int64", "\tpartition T = m", "\t\tsource =", "\t\t\tlet Source = Table.FromRows({ {\"A\",10},{\"B\",20},{\"C\",30} }, type table [k=text, v=Int64.Type]) in Source"].join("\n"), size: 200 },
  ],
  [],
);
const tv = tableProject.report.pages[0].visuals.find((v) => v.id === "t");
assert.equal(tv.style.table.headerBack, "#1F5FA6", "header back color");
assert.equal(tv.style.table.headerColor, "#FFFFFF", "header font color");
assert.equal(tv.style.table.total.show, true, "total enabled");
assert.equal(tv.data.kind, "table");
assert.equal(tv.data.hasNumeric, true, "numeric column detected");
assert.equal(tv.data.totals[1], "60", "sum of v column (10+20+30)");

console.log("table format smoke test passed");

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
