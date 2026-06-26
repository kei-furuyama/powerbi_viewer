import assert from "node:assert/strict";

await import("../app.js");

const { analyzeProject, parseTmdl } = globalThis.PBIPViewerParser;

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

// --- 画像(A): 解決とページ背景 ---
const imgProject = analyzeProject(
  [
    { path: "IMG.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "IMG.Report" } }] }), size: 40 },
    { path: "IMG.Report/definition/report.json", text: JSON.stringify({ resourcePackages: [{ name: "RegisteredResources", items: [{ name: "logo.svg", path: "logo.svg" }] }] }), size: 80 },
    { path: "IMG.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "IMG.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720, objects: { background: [{ properties: { image: { image: { name: { expr: { Literal: { Value: "'bg.svg'" } } }, scaling: { expr: { Literal: { Value: "'Fill'" } } } } } } }] } }), size: 120 },
    { path: "IMG.Report/definition/pages/P/visuals/logo/visual.json", text: JSON.stringify({ name: "logo", position: { x: 0, y: 0, width: 200, height: 120, z: 0 }, visual: { visualType: "image", objects: { general: [{ properties: { imageUrl: { expr: { ResourcePackageItem: { ItemName: "logo.svg" } } } } }] } } }), size: 120 },
    { path: "IMG.Report/StaticResources/RegisteredResources/logo.svg", text: "", isImage: true, dataUrl: "data:image/svg+xml;base64,AAA", size: 100 },
    { path: "IMG.Report/StaticResources/RegisteredResources/bg.svg", text: "", isImage: true, dataUrl: "data:image/svg+xml;base64,BBB", size: 100 },
  ],
  [],
);
const logoVisual = imgProject.report.pages[0].visuals.find((v) => v.id === "logo");
assert.equal(logoVisual.imageRef.name, "logo.svg", "image resource name extracted");
assert.equal(logoVisual.imageData, "data:image/svg+xml;base64,AAA", "image visual resolved to data URL");
assert.equal(imgProject.report.pages[0].background.image.name, "bg.svg", "page background image name");
assert.equal(imgProject.report.pages[0].background.image.scaling, "cover", "Fill -> cover");
assert.equal(imgProject.report.pages[0].background.imageData, "data:image/svg+xml;base64,BBB", "page background resolved");

console.log("image smoke test passed");

// --- チャート仕上げ: コンボ系列分類 / スライサー体裁 ---
const polishTmdl = [
  "table T",
  "\tmeasure 売上 = SUM('T'[v1])",
  "\tmeasure 率 = AVERAGE('T'[v2])",
  "\tcolumn k", "\t\tdataType: string",
  "\tcolumn v1", "\t\tdataType: int64",
  "\tcolumn v2", "\t\tdataType: int64",
  "\tpartition T = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"A\",10,5},{\"B\",20,8} }, type table [k=text, v1=Int64.Type, v2=Int64.Type]) in Source",
].join("\n");
const pm = (p) => ({ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const pc = (p) => ({ field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const pvis = (name, vtype, qs, objects) => ({ path: `PL.Report/definition/pages/P/visuals/${name}/visual.json`, text: JSON.stringify({ name, position: { x: 0, y: 0, width: 400, height: 240, z: 0 }, visual: { visualType: vtype, objects, query: { queryState: qs } } }), size: 200 });
const polishProject = analyzeProject(
  [
    { path: "PL.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "PL.Report" } }] }), size: 40 },
    { path: "PL.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "PL.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    pvis("combo", "lineClusteredColumnComboChart", { Category: { projections: [pc("k")] }, Y: { projections: [pm("売上")] }, Y2: { projections: [pm("率")] } }),
    pvis("sl", "slicer", { Category: { projections: [pc("k")] } }, { general: [{ properties: { orientation: { expr: { Literal: { Value: "'Horizontal'" } } } } }], header: [{ properties: { text: { expr: { Literal: { Value: "'選択'" } } } } }] }),
    { path: "PL.SemanticModel/definition/tables/T.tmdl", text: polishTmdl, size: 300 },
  ],
  [],
);
const comboV = polishProject.report.pages[0].visuals.find((v) => v.id === "combo");
assert.equal(comboV.data.combo, true, "combo detected");
assert.deepEqual(comboV.data.seriesList.map((s) => s.mode), ["bar", "line"], "Y=bar, Y2=line");
const slV = polishProject.report.pages[0].visuals.find((v) => v.id === "sl");
assert.equal(slV.style.slicer.orientation, "horizontal", "slicer horizontal");
assert.equal(slV.style.slicer.headerText, "選択", "slicer header text");

console.log("chart polish smoke test passed");

// --- 条件付き書式: グラデの抽出 ---
const grad = { solid: { color: { expr: { FillRule: { Input: { Measure: { Property: "売上" } }, FillRule: { linearGradient3: { min: { color: { Literal: { Value: "'#E0584E'" } } }, mid: { color: { Literal: { Value: "'#F2C94C'" } } }, max: { color: { Literal: { Value: "'#27AE60'" } } } } } } } } } };
const cfProject = analyzeProject(
  [
    { path: "CF.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "CF.Report" } }] }), size: 40 },
    { path: "CF.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "CF.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    { path: "CF.Report/definition/pages/P/visuals/bar/visual.json", text: JSON.stringify({ name: "bar", position: { x: 0, y: 0, width: 400, height: 240, z: 0 }, visual: { visualType: "clusteredColumnChart", objects: { dataPoint: [{ properties: { fill: grad } }] }, query: { queryState: { Category: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: "k" } }, queryRef: "T.k", nativeQueryRef: "k" }] }, Y: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: "売上" } }, queryRef: "T.売上", nativeQueryRef: "売上" }] } } } } }), size: 200 },
    { path: "CF.SemanticModel/definition/tables/T.tmdl", text: ["table T", "\tmeasure 売上 = SUM('T'[v])", "\tcolumn k", "\t\tdataType: string", "\tcolumn v", "\t\tdataType: int64", "\tpartition T = m", "\t\tsource =", "\t\t\tlet Source = Table.FromRows({ {\"A\",10},{\"B\",90} }, type table [k=text, v=Int64.Type]) in Source"].join("\n"), size: 200 },
  ],
  [],
);
const cfBar = cfProject.report.pages[0].visuals.find((v) => v.id === "bar");
assert.equal(cfBar.style.dataPointRule.kind, "gradient", "data point conditional gradient parsed");
assert.equal(cfBar.style.dataPointRule.stops.length, 3, "3-stop gradient");
assert.equal(cfBar.style.dataPointRule.stops[0].color, "#E0584E", "gradient min color");
assert.equal(cfBar.style.dataPointRule.stops[0].value, undefined, "no fixed stop value -> data domain used");

console.log("conditional formatting smoke test passed");

// --- テーブル: メジャー列の行ごと評価 + 合計 ---
const mtTmdl = [
  "table 売上",
  "\tmeasure 売上合計 = SUM('売上'[金額])",
  "\t\tformatString: #,0\"円\"",
  "\tmeasure 件数 = COUNTROWS('売上')",
  "\tcolumn 地域", "\t\tdataType: string",
  "\tcolumn 金額", "\t\tdataType: int64",
  "\tpartition 売上 = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"東\",1200},{\"東\",800},{\"西\",1500},{\"北\",2000} }, type table [地域=text, 金額=Int64.Type]) in Source",
].join("\n");
const mtM = (p) => ({ field: { Measure: { Expression: { SourceRef: { Entity: "売上" } }, Property: p } }, queryRef: "売上." + p, nativeQueryRef: p });
const mtC = (p) => ({ field: { Column: { Expression: { SourceRef: { Entity: "売上" } }, Property: p } }, queryRef: "売上." + p, nativeQueryRef: p });
const mtProject = analyzeProject(
  [
    { path: "MT.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "MT.Report" } }] }), size: 40 },
    { path: "MT.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "MT.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    { path: "MT.Report/definition/pages/P/visuals/t/visual.json", text: JSON.stringify({ name: "t", position: { x: 0, y: 0, width: 600, height: 300, z: 0 }, visual: { visualType: "tableEx", objects: { total: [{ properties: { show: { expr: { Literal: { Value: "true" } } } } }] }, query: { queryState: { Rows: { projections: [mtC("地域")] }, Values: { projections: [mtM("売上合計"), mtM("件数")] } } } } }), size: 200 },
    { path: "MT.SemanticModel/definition/tables/売上.tmdl", text: mtTmdl, size: 300 },
  ],
  [],
);
const mtT = mtProject.report.pages[0].visuals.find((v) => v.id === "t").data;
assert.deepEqual(mtT.columns, ["地域", "売上合計", "件数"], "measure columns kept in table");
assert.deepEqual(mtT.numericCol, [false, true, true], "measure columns are numeric (right-aligned)");
const tokyo = mtT.rows.find((r) => r[0] === "東");
assert.equal(tokyo[1], "2,000円", "per-row measure with formatString (東: 1200+800)");
assert.equal(tokyo[2], "2", "per-row COUNTROWS for 東");
assert.equal(mtT.totals[1], "5,500円", "grand total measure (1200+800+1500+2000)");
assert.equal(mtT.totals[2], "4", "grand total count");

console.log("measure-table smoke test passed");

// --- 監査修正: multiRowCard全メジャー / gauge範囲 / <> 演算子 ---
const auTmdl = [
  "table T",
  "\tmeasure 売上 = SUM('T'[v])",
  "\tmeasure 利益 = SUM('T'[p])",
  "\tmeasure 件数 = COUNTROWS('T')",
  "\tmeasure 目標 = 100",
  "\tcolumn k", "\t\tdataType: string",
  "\tcolumn v", "\t\tdataType: int64",
  "\tcolumn p", "\t\tdataType: int64",
  "\tpartition T = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"A\",60,20},{\"B\",40,10} }, type table [k=text, v=Int64.Type, p=Int64.Type]) in Source",
].join("\n");
const auM = (p) => ({ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const auVis = (name, vtype, qs) => ({ path: `AU.Report/definition/pages/P/visuals/${name}/visual.json`, text: JSON.stringify({ name, position: { x: 0, y: 0, width: 300, height: 200, z: 0 }, visual: { visualType: vtype, query: { queryState: qs } } }), size: 200 });
const auProject = analyzeProject(
  [
    { path: "AU.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "AU.Report" } }] }), size: 40 },
    { path: "AU.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "AU.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    auVis("mrc", "multiRowCard", { Values: { projections: [auM("売上"), auM("利益"), auM("件数")] } }),
    auVis("g", "gauge", { Y: { projections: [auM("売上")] }, TargetValue: { projections: [auM("目標")] } }),
    { path: "AU.SemanticModel/definition/tables/T.tmdl", text: auTmdl, size: 400 },
  ],
  [],
);
const mrc = auProject.report.pages[0].visuals.find((v) => v.id === "mrc").data;
assert.equal(mrc.kind, "multicard", "multiRowCard -> multicard");
assert.equal(mrc.cards.length, 3, "all 3 measures rendered (not just first)");
assert.equal(mrc.cards[1].label, "利益", "second measure present");
const gauge = auProject.report.pages[0].visuals.find((v) => v.id === "g").data;
assert.equal(gauge.kind, "gauge", "gauge kind");
assert.equal(gauge.value, 100, "gauge value = SUM (60+40)");
assert.equal(gauge.max, 100, "gauge max from TargetValue role");

// <> 演算子(ComparisonKind 5)のフィルタ
const neTmdl = ["table T", "\tmeasure 件数 = COUNTROWS('T')", "\tcolumn s", "\t\tdataType: string", "\tpartition T = m", "\t\tsource =", "\t\t\tlet Source = Table.FromRows({ {\"X\"},{\"X\"},{\"Y\"} }, type table [s=text]) in Source"].join("\n");
const neFilterConfig = {
  filters: [{
    name: "f",
    field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: "s" } },
    filter: { Where: [{ Condition: { Comparison: { ComparisonKind: 5, Left: { Column: { Property: "s" } }, Right: { Literal: { Value: "'X'" } } } } }] },
  }],
};
const neVisual = { name: "c", position: { x: 0, y: 0, width: 200, height: 120, z: 0 }, filterConfig: neFilterConfig, visual: { visualType: "cardVisual", query: { queryState: { Data: { projections: [auM("件数")] } } } } };
const neProject = analyzeProject(
  [
    { path: "NE.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "NE.Report" } }] }), size: 40 },
    { path: "NE.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "NE.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    { path: "NE.Report/definition/pages/P/visuals/c/visual.json", text: JSON.stringify(neVisual), size: 200 },
    { path: "NE.SemanticModel/definition/tables/T.tmdl", text: neTmdl, size: 200 },
  ],
  [],
);
// s <> "X" -> only the 1 "Y" row
assert.equal(neProject.report.pages[0].visuals[0].data.text, "1", "<> (not equals) filter keeps only non-X rows");

console.log("audit fixes smoke test passed");

// --- 続き: scatter X/Y, shape line ---
const ct2Tmdl = [
  "table T",
  "\tmeasure X = SUM('T'[x])",
  "\tmeasure Y = SUM('T'[y])",
  "\tcolumn k", "\t\tdataType: string",
  "\tcolumn x", "\t\tdataType: int64",
  "\tcolumn y", "\t\tdataType: int64",
  "\tpartition T = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"A\",10,80},{\"B\",90,20} }, type table [k=text, x=Int64.Type, y=Int64.Type]) in Source",
].join("\n");
const ct2M = (p) => ({ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const ct2C = (p) => ({ field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: p } }, queryRef: "T." + p, nativeQueryRef: p });
const ct2Project = analyzeProject(
  [
    { path: "C2.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "C2.Report" } }] }), size: 40 },
    { path: "C2.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "C2.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    { path: "C2.Report/definition/pages/P/visuals/sc/visual.json", text: JSON.stringify({ name: "sc", position: { x: 0, y: 0, width: 300, height: 200, z: 0 }, visual: { visualType: "scatterChart", query: { queryState: { Category: { projections: [ct2C("k")] }, X: { projections: [ct2M("X")] }, Y: { projections: [ct2M("Y")] } } } } }), size: 200 },
    { path: "C2.Report/definition/pages/P/visuals/sh/visual.json", text: JSON.stringify({ name: "sh", position: { x: 0, y: 220, width: 300, height: 120, z: 0 }, visual: { visualType: "shape", objects: { line: [{ properties: { lineColor: { solid: { color: { expr: { Literal: { Value: "'#1F5FA6'" } } } } }, weight: { expr: { Literal: { Value: "4D" } } } } }] } } }), size: 200 },
    { path: "C2.SemanticModel/definition/tables/T.tmdl", text: ct2Tmdl, size: 300 },
  ],
  [],
);
const sc = ct2Project.report.pages[0].visuals.find((v) => v.id === "sc").data;
assert.ok(sc.seriesList.length >= 2, "scatter has X and Y series");
assert.deepEqual(sc.seriesList[0].values.slice().sort((a, b) => a - b), [10, 90], "scatter X measure values");
const sh = ct2Project.report.pages[0].visuals.find((v) => v.id === "sh");
assert.equal(sh.style.line.color, "#1F5FA6", "shape line color");
assert.equal(sh.style.line.weight, 4, "shape line weight");

console.log("continue fixes smoke test passed");

// --- ウォーターフォール: 元の順序を維持(降順ソートしない) ---
const wfTmdl = [
  "table T",
  "\tmeasure 増減 = SUM('T'[d])",
  "\tcolumn k", "\t\tdataType: string",
  "\tcolumn o", "\t\tdataType: int64",
  "\tcolumn d", "\t\tdataType: int64",
  "\tpartition T = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"開始\",1,100},{\"四\",2,40},{\"五\",3,-30} }, type table [k=text, o=Int64.Type, d=Int64.Type]) in Source",
].join("\n");
const wfProject = analyzeProject(
  [
    { path: "WF.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "WF.Report" } }] }), size: 40 },
    { path: "WF.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "WF.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    { path: "WF.Report/definition/pages/P/visuals/wf/visual.json", text: JSON.stringify({ name: "wf", position: { x: 0, y: 0, width: 400, height: 240, z: 0 }, visual: { visualType: "waterfallChart", query: { queryState: { Category: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "T" } }, Property: "k" } }, queryRef: "T.k", nativeQueryRef: "k" }] }, Y: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: "T" } }, Property: "増減" } }, queryRef: "T.増減", nativeQueryRef: "増減" }] } } } } }), size: 200 },
    { path: "WF.SemanticModel/definition/tables/T.tmdl", text: wfTmdl, size: 300 },
  ],
  [],
);
const wf = wfProject.report.pages[0].visuals[0].data;
assert.deepEqual(wf.categories, ["開始", "四", "五"], "waterfall keeps original order (not value-sorted)");
assert.deepEqual(wf.series.map((p) => p.value), [100, 40, -30], "waterfall values incl. negative");

console.log("waterfall smoke test passed");

// --- ビジュアル背景/枠線/影の設定 ---
const solid = (hex) => ({ solid: { color: { expr: { Literal: { Value: `'${hex}'` } } } } });
const lit = (v) => ({ expr: { Literal: { Value: String(v) } } });
const bgCard = (name, vco) => ({ path: `BG.Report/definition/pages/P/visuals/${name}/visual.json`, text: JSON.stringify({ name, position: { x: 0, y: 0, width: 200, height: 120, z: 0 }, visual: { visualType: "cardVisual", visualContainerObjects: vco, query: { queryState: { Data: { projections: [ct2M("X")] } } } } }), size: 200 });
const bgProject = analyzeProject(
  [
    { path: "BG.pbip", text: JSON.stringify({ version: "1.0", artifacts: [{ report: { path: "BG.Report" } }] }), size: 40 },
    { path: "BG.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["P"] }), size: 30 },
    { path: "BG.Report/definition/pages/P/page.json", text: JSON.stringify({ name: "P", displayName: "P", width: 1280, height: 720 }), size: 60 },
    bgCard("off", { background: [{ properties: { show: lit("false") } }] }),
    bgCard("semi", { background: [{ properties: { color: solid("#1F5FA6"), transparency: lit("60D") } }], border: [{ properties: { show: lit("true"), color: solid("#1F5FA6"), weight: lit("3D") } }], dropShadow: [{ properties: { show: lit("true") } }] }),
    { path: "BG.SemanticModel/definition/tables/T.tmdl", text: ct2Tmdl, size: 300 },
  ],
  [],
);
const offV = bgProject.report.pages[0].visuals.find((v) => v.id === "off");
assert.equal(offV.style.background.show, false, "background show:false detected");
const semiV = bgProject.report.pages[0].visuals.find((v) => v.id === "semi");
assert.equal(semiV.style.background.transparency, 60, "background transparency parsed");
assert.equal(semiV.style.border.width, 3, "border weight parsed");
assert.equal(semiV.style.shadow.show, true, "drop shadow detected");

console.log("visual background smoke test passed");

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

// --- model static analysis: transitive unused, cycle, division lint, unused columns ---
const modelTmdl = [
  "table T",
  "\tcolumn k",
  "\t\tdataType: string",
  "\tcolumn v",
  "\t\tdataType: int64",
  "\tcolumn 未使用列",
  "\t\tdataType: int64",
  "\tmeasure Base = SUM('T'[v])",            // used by a visual (root)
  "\tmeasure Helper = [Base] * 2",           // used transitively via Base->Helper? no: Visual uses Ratio
  "\tmeasure Ratio = [Helper] / [Base]",     // root (bound to card); division lint
  "\tmeasure DeadA = [DeadB] + 1",           // dead cycle
  "\tmeasure DeadB = [DeadA] + 1",           // dead cycle
  "\tmeasure Orphan = [Base] + 1",           // referenced by nobody, references Base (Base still used via Ratio)
  "\tpartition T = m",
  "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"A\",10},{\"B\",20} }, type table [k=text, v=Int64.Type]) in Source",
].join("\n");

const modelProject = analyzeProject(
  [
    {
      path: "MA.Report/definition/pages/p/visuals/v/visual.json",
      text: JSON.stringify({
        name: "v",
        position: { x: 0, y: 0, width: 200, height: 120, z: 0 },
        visual: {
          visualType: "card",
          query: { queryState: { Values: { projections: [{ field: { Measure: { Property: "Ratio" } }, queryRef: "Ratio" }] } } },
        },
      }),
      size: 200,
    },
    { path: "MA.Report/definition/pages/p/page.json", text: JSON.stringify({ name: "p", displayName: "P", width: 1280, height: 720 }), size: 80 },
    { path: "MA.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["p"], activePageName: "p" }), size: 60 },
    { path: "MA.SemanticModel/definition/tables/T.tmdl", text: modelTmdl, size: 400 },
  ],
  [],
);

const mUsage = modelProject.measureUsage;
const mByName = {};
for (const t of modelProject.semantic.tables) for (const m of t.measures) mByName[m.name] = m;

// transitive usage: Ratio (root) -> Helper -> Base are used; Orphan/DeadA/DeadB are unused
assert.equal(mByName["Ratio"].used, true, "Ratio is the visual root");
assert.equal(mByName["Helper"].used, true, "Helper is used transitively by Ratio");
assert.equal(mByName["Base"].used, true, "Base is used transitively");
assert.equal(mByName["Orphan"].used, false, "Orphan is unused (referenced by nobody)");
assert.equal(mByName["DeadA"].used, false, "DeadA is unused (dead cycle)");
assert.equal(mByName["DeadB"].used, false, "DeadB is unused (dead cycle)");

// dependency graph + reverse index
assert.ok(mByName["Ratio"].dependsOn.some((d) => /Helper/.test(d)), "Ratio dependsOn Helper");
assert.ok(mByName["Base"].referencedBy.some((d) => /Helper/.test(d)), "Base referencedBy Helper");

// cycle detection
assert.ok(mUsage.cycles.length >= 1, "a measure cycle is detected");
assert.equal(mByName["DeadA"].inCycle, true, "DeadA flagged inCycle");
assert.equal(mByName["DeadB"].inCycle, true, "DeadB flagged inCycle");

// DAX lint: Ratio uses '/'
assert.ok(mUsage.lint.some((l) => /Ratio/.test(l.measure) && l.rule === "division"), "division lint on Ratio");

// unused columns: 未使用列 is referenced nowhere; k/v are used (v by Base, k... not referenced -> unused)
assert.equal(mByName ? mByName["Base"].used : true, true);
const colsByName = {};
for (const c of modelProject.semantic.tables[0].columns) colsByName[c.name] = c;
assert.equal(colsByName["v"].used, true, "column v is used by Base measure");
assert.equal(colsByName["未使用列"].used, false, "未使用列 is unused");
assert.ok(mUsage.unusedColumns >= 1, "unused columns counted");

console.log("model static analysis smoke test passed");

// --- whole-codebase review regression fixes ---
// #10 & precedence, #3 SWITCH, #4 AND/OR/NOT, #22 IFERROR
assert.equal(evaluateDax('"R" & 1 + 2', { rows: [{}], row: {} }), "R3", "& binds below +");
assert.equal(evaluateDax('SWITCH(2, 1, "a", 2, "b", "d")', { rows: [{}], row: {} }), "b", "SWITCH value match");
assert.equal(evaluateDax('SWITCH(TRUE(), 1>2, "x", 1<2, "y")', { rows: [{}], row: {} }), "y", "SWITCH(TRUE())");
assert.equal(evaluateDax('AND(TRUE(), FALSE())', { rows: [{}], row: {} }), false, "AND()");
assert.equal(evaluateDax('OR(FALSE(), TRUE())', { rows: [{}], row: {} }), true, "OR()");
assert.equal(evaluateDax('NOT(FALSE())', { rows: [{}], row: {} }), true, "NOT()");

// #1 multi-line measure (bare continuation + backtick block) + #21 property scope
const mlTmdl = [
  "table T",
  "\tmeasure Total =",
  "\t\t\tCALCULATE(",
  "\t\t\t\tSUM(T[Amt])",
  "\t\t\t)",
  "\t\tformatString: #,##0",
  "\tmeasure Fenced = ```",
  "\t\t\tSUMX(T, T[Amt])",
  "\t\t\t```",
  "\tcolumn Amt",
  "\t\tdataType: int64",
].join("\n");
const mlParsed = parseTmdl(mlTmdl, "T", "T.tmdl");
const mlM = Object.fromEntries(mlParsed.tables[0].measures.map((m) => [m.name, m]));
assert.ok(/CALCULATE/.test(mlM["Total"].expression) && /SUM\(T\[Amt\]\)/.test(mlM["Total"].expression), "multi-line bare measure captured");
assert.equal(mlM["Total"].formatString, "#,##0", "formatString not swallowed by measure body (#21)");
assert.ok(/SUMX/.test(mlM["Fenced"].expression) && !mlM["Fenced"].expression.includes("```"), "backtick measure captured, fences stripped");

// #5 Japanese qualified ref + #6 self-ref cycle + #8 hierarchy not a hard error
const jpVisual = {
  name: "v", position: { x: 0, y: 0, width: 100, height: 80, z: 0 },
  visual: { visualType: "card", query: { queryState: { Values: { projections: [{ field: { Measure: { Property: "合計" } }, queryRef: "合計" }] } } } },
};
const jpProject = analyzeProject([
  { path: "J.Report/definition/pages/p/visuals/v/visual.json", text: JSON.stringify(jpVisual), size: 200 },
  { path: "J.Report/definition/pages/p/page.json", text: JSON.stringify({ name: "p", displayName: "P", width: 1280, height: 720 }), size: 80 },
  { path: "J.Report/definition/pages/p/pages.json", text: JSON.stringify({ pageOrder: ["p"], activePageName: "p" }), size: 60 },
  { path: "J.SemanticModel/definition/tables/売上.tmdl", text: ["table 売上", "\tcolumn 金額", "\t\tdataType: int64", "\tcolumn 未使用", "\t\tdataType: int64", "\tmeasure 合計 = SUM(売上[金額])", "\tmeasure 自己 = [自己] + 1"].join("\n"), size: 300 },
], []);
const jpCols = Object.fromEntries(jpProject.semantic.tables[0].columns.map((c) => [c.name, c]));
assert.equal(jpCols["金額"].used, true, "Japanese qualified ref 売上[金額] marks 金額 used (#5)");
assert.equal(jpCols["未使用"].used, false, "未使用 column detected");
assert.ok(jpProject.measureUsage.cycles.some((ring) => ring.join().includes("自己")), "self-reference cycle detected (#6)");

console.log("review regression smoke test passed");

// --- extended DAX functions (date / math / text / info / table) ---
const dx = (expr) => evaluateDax(expr, [{}], { columns: [], records: [{}] }, new Map());
assert.equal(dx("YEAR(DATE(2024,3,15))"), 2024, "YEAR(DATE())");
assert.equal(dx("MONTH(DATE(2024,3,15))"), 3, "MONTH");
assert.equal(dx('DATEDIFF(DATE(2024,1,1), DATE(2024,3,1), "DAY")'), 60, "DATEDIFF DAY");
assert.equal(dx('DATEDIFF(DATE(2024,1,15), DATE(2024,3,10), "MONTH")'), 2, "DATEDIFF MONTH");
assert.equal(dx("DAY(EOMONTH(DATE(2024,2,10),0))"), 29, "EOMONTH leap");
assert.equal(dx("MONTH(EDATE(DATE(2024,1,31),1))"), 2, "EDATE");
assert.equal(dx("WEEKDAY(DATE(2024,3,4),2)"), 1, "WEEKDAY Monday type2");
assert.equal(dx('YEAR("2023-07-09")'), 2023, "YEAR of date string");
assert.equal(dx('FORMAT(DATE(2024,3,5),"yyyy/MM/dd")'), "2024/03/05", "FORMAT date");
assert.equal(dx("POWER(2,10)"), 1024, "POWER");
assert.equal(dx("MOD(10,3)"), 1, "MOD");
assert.equal(dx("CEILING(23,10)"), 30, "CEILING");
assert.equal(dx("SQRT(144)"), 12, "SQRT");
assert.equal(dx("QUOTIENT(17,5)"), 3, "QUOTIENT");
assert.equal(dx('LEFT("abcdef",3)'), "abc", "LEFT");
assert.equal(dx('MID("abcdef",2,3)'), "bcd", "MID");
assert.equal(dx('LEN("あいう")'), 3, "LEN");
assert.equal(dx('SUBSTITUTE("a-b-c","-","+")'), "a+b+c", "SUBSTITUTE");
assert.equal(dx('FIND("c","abcde")'), 3, "FIND");
assert.equal(dx('VALUE("1,234")'), 1234, "VALUE");
assert.equal(dx("ISBLANK(BLANK())"), true, "ISBLANK");
assert.equal(dx("ISNUMBER(5)"), true, "ISNUMBER");

// table functions over inline data: TOPN / MEDIAN / CONCATENATEX / RANKX
const dxTmdl = [
  "table S",
  "\tcolumn 地域", "\t\tdataType: string",
  "\tcolumn 金額", "\t\tdataType: int64",
  "\tmeasure TOP3 = SUMX(TOPN(3, S, [金額]), [金額])",
  "\tmeasure 中央 = MEDIAN(S[金額])",
  "\tmeasure 連結 = CONCATENATEX(TOPN(2, S, [金額]), S[地域], \"|\")",
  "\tmeasure R250 = RANKX(S, [金額], 250)",
  "\tpartition S = m", "\t\tsource =",
  "\t\t\tlet Source = Table.FromRows({ {\"東\",300},{\"西\",100},{\"南\",250},{\"北\",50},{\"中\",150} }, type table [地域 = text, 金額 = Int64.Type]) in Source",
].join("\n");
const dxProject = analyzeProject([{ path: "DX.SemanticModel/definition/tables/S.tmdl", text: dxTmdl, size: 400 }], []);
const dxTable = dxProject.semantic.tables[0];
const dxModel = new Map([[dxTable.name, { name: dxTable.name, columns: dxTable.data.columns, records: dxTable.data.records, measures: new Map(dxTable.measures.map((m) => [m.name, m])) }]]);
const dxEv = (n) => evaluateDax(dxTable.measures.find((m) => m.name === n).expression, dxTable.data.records, dxModel.get(dxTable.name), dxModel);
assert.equal(dxEv("TOP3"), 700, "SUMX(TOPN(3)) = 300+250+150");
assert.equal(dxEv("中央"), 150, "MEDIAN");
assert.equal(dxEv("連結"), "東|南", "CONCATENATEX over TOPN(2)");
assert.equal(dxEv("R250"), 2, "RANKX of 250 desc = 2");

console.log("extended DAX functions smoke test passed");

// --- Phase 1: relationship-aware DAX + time intelligence ---
{
  const sales = { name: "Sales", columns: [{ name: "地域ID" }, { name: "金額" }], records: [{ 地域ID: 1, 金額: 100 }, { 地域ID: 2, 金額: 200 }, { 地域ID: 1, 金額: 50 }], measures: new Map() };
  const dim = { name: "地域", columns: [{ name: "地域ID" }, { name: "地域名" }], records: [{ 地域ID: 1, 地域名: "東" }, { 地域ID: 2, 地域名: "西" }], measures: new Map() };
  const rel = new Map([["Sales", sales], ["地域", dim]]);
  rel.relationships = [{ fromTable: "Sales", fromColumn: "地域ID", toTable: "地域", toColumn: "地域ID", isActive: true, toCardinality: "one" }];
  assert.equal(evaluateDax('CONCATENATEX(Sales, RELATED(地域[地域名]), ",")', sales.records, sales, rel), "東,西,東", "RELATED follows m:1");
  assert.equal(evaluateDax('SUMX(FILTER(Sales, RELATED(地域[地域名])="東"), [金額])', sales.records, sales, rel), 150, "RELATED inside FILTER");
  assert.equal(evaluateDax("SUMX(RELATEDTABLE(Sales), [金額])", dim.records.filter((r) => r.地域名 === "東"), dim, rel), 150, "RELATEDTABLE from dim filter context");
  assert.equal(evaluateDax("SUMX(Sales, [金額])", dim.records, dim, rel), 350, "cross-table SUMX switches table context");

  const tt = { name: "T", columns: [{ name: "日付" }, { name: "金額" }], records: [{ 日付: "2023-03-01", 金額: 100 }, { 日付: "2024-03-01", 金額: 150 }, { 日付: "2024-09-01", 金額: 70 }], measures: new Map() };
  const tm = new Map([["T", tt]]); tm.relationships = [];
  assert.equal(evaluateDax("SUM(T[金額])", tt.records, tt, tm), 320, "baseline SUM");
  assert.equal(evaluateDax("TOTALYTD(SUM(T[金額]), T[日付])", tt.records, tt, tm), 220, "TOTALYTD picks current year (150+70)");
  assert.equal(evaluateDax("CALCULATE(SUM(T[金額]), SAMEPERIODLASTYEAR(T[日付]))", tt.records, tt, tm), 100, "SAMEPERIODLASTYEAR");
  assert.equal(evaluateDax('CALCULATE(SUM(T[金額]), DATEADD(T[日付], -1, "YEAR"))', tt.records, tt, tm), 100, "DATEADD -1 year");
  assert.equal(evaluateDax("CALCULATE(SUM(T[金額]), REMOVEFILTERS(T))", tt.records.filter((r) => r.日付 === "2024-03-01"), tt, tm), 320, "REMOVEFILTERS restores all rows");
}

console.log("relationship + time intelligence DAX smoke test passed");

// --- Phase 3: model analysis (RLS / calc groups / refresh policy / best practices) ---
{
  const factTmdl = ["table 売上", "\tcolumn 地域ID", "\t\tdataType: int64", "\tcolumn 金額", "\t\tdataType: int64", "\tmeasure 売上合計 = SUM(売上[金額])", "\tcolumn 隠し", "\t\tdataType: string", "\t\tisHidden", "\tpartition 売上 = m", "\t\trefreshPolicy basic"].join("\n");
  const dimTmdl = ["table 地域", "\tcolumn 地域ID", "\t\tdataType: int64", "\tcolumn 地域名", "\t\tdataType: string"].join("\n");
  const relTmdl = ["relationship r1", "\tfromColumn: 売上.地域ID", "\ttoColumn: 地域.地域ID", "\tcrossFilteringBehavior: bothDirections"].join("\n");
  const roleTmdl = ["role 営業", "\ttablePermission 売上 = 売上[地域ID] = 1"].join("\n");
  const calcTmdl = ["table 時間計算", "\tcalculationGroup", "\t\tcalculationItem 累計 = CALCULATE([売上合計])"].join("\n");
  const hiddenColField = { Column: { Expression: { SourceRef: { Entity: "売上" } }, Property: "隠し" } };
  const hiddenProjection = { field: hiddenColField, queryRef: "売上.隠し" };
  const visual = {
    name: "v",
    position: { x: 0, y: 0, width: 100, height: 80, z: 0 },
    visual: { visualType: "table", query: { queryState: { Values: { projections: [hiddenProjection] } } } },
  };
  const proj = analyzeProject([
    { path: "X.Report/definition/pages/p/visuals/v/visual.json", text: JSON.stringify(visual), size: 200 },
    { path: "X.Report/definition/pages/p/page.json", text: JSON.stringify({ name: "p", displayName: "P", width: 1280, height: 720 }), size: 80 },
    { path: "X.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["p"], activePageName: "p" }), size: 60 },
    { path: "X.SemanticModel/definition/tables/売上.tmdl", text: factTmdl, size: 300 },
    { path: "X.SemanticModel/definition/tables/地域.tmdl", text: dimTmdl, size: 200 },
    { path: "X.SemanticModel/definition/relationships.tmdl", text: relTmdl, size: 120 },
    { path: "X.SemanticModel/definition/roles.tmdl", text: roleTmdl, size: 100 },
    { path: "X.SemanticModel/definition/tables/時間計算.tmdl", text: calcTmdl, size: 120 },
  ], []);
  assert.equal(proj.semantic.roles.length, 1, "RLSロールが1件抽出される");
  assert.equal(proj.semantic.roles[0].name, "営業", "ロール名");
  assert.equal(proj.semantic.calculationGroups.length, 1, "計算グループが1件");
  assert.equal(proj.semantic.calculationGroups[0].table, "時間計算", "計算グループのテーブル名は宣言から取得");
  assert.equal(proj.semantic.calculationGroups[0].items.length, 1, "計算項目が1件");
  assert.ok(proj.semantic.refreshPolicies.length >= 1, "更新ポリシーが検出される");
  const bpRules = proj.bestPractices.map((b) => b.rule);
  assert.ok(bpRules.includes("measure-format"), "BPA: 書式無しメジャー");
  assert.ok(bpRules.includes("bidi-rel"), "BPA: 双方向クロスフィルタ");
  assert.ok(bpRules.includes("hidden-used"), "BPA: 非表示列をビジュアルで使用");
}

console.log("model analysis (RLS/calc/refresh/BPA) smoke test passed");

// --- Phase 4: slicer carries table/column for cross-filtering ---
{
  const slField = { Column: { Expression: { SourceRef: { Entity: "売上" } }, Property: "地域" } };
  const slVisual = { name: "sl", position: { x: 0, y: 0, width: 200, height: 300, z: 0 }, visual: { visualType: "slicer", query: { queryState: { Values: { projections: [{ field: slField, queryRef: "売上.地域" }] } } } } };
  const xfTmdl = ["table 売上", "\tcolumn 地域", "\t\tdataType: string", "\tcolumn 金額", "\t\tdataType: int64", "\tmeasure 合計 = SUM(売上[金額])", "\tpartition 売上 = m", "\t\tsource =", "\t\t\tlet Source = Table.FromRows({ {\"東\",300},{\"西\",100},{\"南\",250} }, type table [地域 = text, 金額 = Int64.Type]) in Source"].join("\n");
  const xfProj = analyzeProject([
    { path: "XF.Report/definition/pages/p/visuals/sl/visual.json", text: JSON.stringify(slVisual), size: 200 },
    { path: "XF.Report/definition/pages/p/page.json", text: JSON.stringify({ name: "p", displayName: "P", width: 1280, height: 720 }), size: 80 },
    { path: "XF.Report/definition/pages/pages.json", text: JSON.stringify({ pageOrder: ["p"], activePageName: "p" }), size: 60 },
    { path: "XF.SemanticModel/definition/tables/売上.tmdl", text: xfTmdl, size: 320 },
  ], []);
  const slData = xfProj.report.visuals.find((v) => v.type.toLowerCase().includes("slicer"))?.data;
  assert.ok(slData && slData.kind === "slicer", "スライサーのデータが生成される");
  assert.equal(slData.table, "売上", "スライサーが対象テーブルを保持");
  assert.equal(slData.column, "地域", "スライサーが対象列を保持");
  assert.deepEqual(slData.items.sort(), ["東", "西", "南"].sort(), "スライサー項目が一意な値");
}

console.log("slicer cross-filter data smoke test passed");

// --- phase 1-4 audit fixes: cross-table DAX, time intelligence, model extras ---
{
  const sales = { name: "Sales", columns: [{ name: "PK" }, { name: "Amount" }], records: [{ PK: 1, Amount: 100 }, { PK: 1, Amount: 50 }, { PK: 2, Amount: 200 }, { PK: 3, Amount: 30 }], measures: new Map() };
  const prod = { name: "Product", columns: [{ name: "PK" }, { name: "Cat" }], records: [{ PK: 1, Cat: "A" }, { PK: 2, Cat: "B" }, { PK: 3, Cat: "A" }], measures: new Map() };
  const m = new Map([["Sales", sales], ["Product", prod]]);
  m.relationships = [{ fromTable: "Sales", fromColumn: "PK", toTable: "Product", toColumn: "PK", isActive: true }];
  assert.equal(evaluateDax("SUM(Product[PK])", sales.records, sales, m), 6, "#2 cross-table aggregation");
  assert.equal(evaluateDax('CALCULATE(SUM(Sales[Amount]), Product[Cat]="A")', sales.records, sales, m), 180, "#1 CALCULATE dim predicate -> fact");
  assert.equal(evaluateDax('CALCULATE(SUM(Sales[Amount]), FILTER(ALL(Product), Product[Cat]="A"))', sales.records, sales, m), 180, "#1 CALCULATE FILTER(ALL(dim))");
  assert.equal(evaluateDax('CONCATENATEX(Sales, CALCULATE(RELATED(Product[Cat])), "")', sales.records, sales, m), "AABA", "#3 RELATED inside CALCULATE keeps row context");
}
{
  // #16 dim measure referencing fact measure, iterated (context transition)
  const f = { name: "Fact", columns: [{ name: "K" }, { name: "V" }], records: [{ K: 1, V: 100 }, { K: 1, V: 50 }, { K: 2, V: 200 }], measures: new Map([["FV", { name: "FV", expression: "SUM(Fact[V])" }]]) };
  const d = { name: "Dim", columns: [{ name: "K" }], records: [{ K: 1 }, { K: 2 }], measures: new Map() };
  const m2 = new Map([["Fact", f], ["Dim", d]]); m2.relationships = [{ fromTable: "Fact", fromColumn: "K", toTable: "Dim", toColumn: "K", isActive: true }];
  assert.equal(evaluateDax("SUMX(Dim, [FV])", d.records, d, m2), 350, "#16 cross-table measure ref context transition");
}
{
  // #4/#5 time intelligence barewords + off-by-one
  const tt = { name: "T", columns: [{ name: "D" }, { name: "V" }], records: [{ D: "2024-01-15", V: 10 }, { D: "2024-02-10", V: 20 }, { D: "2024-03-05", V: 30 }, { D: "2023-02-10", V: 7 }], measures: new Map() };
  const tm = new Map([["T", tt]]); tm.relationships = [];
  assert.equal(evaluateDax("CALCULATE(SUM(T[V]), DATEADD(T[D], -1, YEAR))", tt.records, tt, tm), 7, "#4 DATEADD bareword YEAR");
  assert.equal(evaluateDax("CALCULATE(SUM(T[V]), DATESINPERIOD(T[D], DATE(2024,2,10), 3, DAY))", tt.records, tt, tm), 20, "#5 DATESINPERIOD exact window");
}
{
  // #6 cross-table time intelligence
  const sales = { name: "S", columns: [{ name: "DK" }, { name: "A" }], records: [{ DK: "2024-01-15", A: 10 }, { DK: "2024-06-20", A: 20 }, { DK: "2023-03-01", A: 5 }], measures: new Map() };
  const cal = { name: "C", columns: [{ name: "DK" }, { name: "Date" }], records: [{ DK: "2024-01-15", Date: "2024-01-15" }, { DK: "2024-06-20", Date: "2024-06-20" }, { DK: "2023-03-01", Date: "2023-03-01" }], measures: new Map() };
  const m = new Map([["S", sales], ["C", cal]]); m.relationships = [{ fromTable: "S", fromColumn: "DK", toTable: "C", toColumn: "DK", isActive: true }];
  assert.equal(evaluateDax("TOTALYTD(SUM(S[A]), C[Date])", sales.records, sales, m), 30, "#6 cross-table TOTALYTD");
}
{
  // #9/#18 multi-line calculationItem + tablePermission
  const calc = ["table TC", "\tcalculationGroup", "\t\tcalculationItem 累計 =", "\t\t\tCALCULATE(", "\t\t\t\t[X]", "\t\t\t)"].join("\n");
  const roleT = ["role R", "\ttablePermission Sales =", "\t\tSales[K] = 1"].join("\n");
  const proj = analyzeProject([
    { path: "MX.SemanticModel/definition/tables/TC.tmdl", text: calc, size: 120 },
    { path: "MX.SemanticModel/definition/roles.tmdl", text: roleT, size: 80 },
  ], []);
  assert.ok(/CALCULATE/.test(proj.semantic.calculationGroups[0].items[0].expression), "#9 multi-line calculationItem captured");
  assert.ok(/Sales\[K\]/.test(proj.semantic.roles[0].permissions[0].filter), "#18 multi-line tablePermission captured");
}

console.log("phase 1-4 audit fixes smoke test passed");
