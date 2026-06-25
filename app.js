(() => {
  const TEXT_LIMIT = 8 * 1024 * 1024;
  const DEFAULT_PAGE = { width: 1280, height: 720 };
  const state = {
    project: null,
    activeTab: "canvas",
    selectedPageId: null,
    selectedVisualId: null,
  };

  const els = {};

  const globalTarget = typeof window !== "undefined" ? window : globalThis;

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", init);
  }

  function init() {
    bindElements();
    bindEvents();
    render();
  }

  function bindElements() {
    Object.assign(els, {
      folderInput: document.getElementById("folderInput"),
      fileInput: document.getElementById("fileInput"),
      exportButton: document.getElementById("exportButton"),
      statusText: document.getElementById("statusText"),
      dropZone: document.getElementById("dropZone"),
      emptyState: document.getElementById("emptyState"),
      summaryMetrics: document.getElementById("summaryMetrics"),
      pageList: document.getElementById("pageList"),
      pageSelect: document.getElementById("pageSelect"),
      canvasMeta: document.getElementById("canvasMeta"),
      reportCanvas: document.getElementById("reportCanvas"),
      visualInspector: document.getElementById("visualInspector"),
      visualTable: document.getElementById("visualTable"),
      modelExplorer: document.getElementById("modelExplorer"),
      fileTable: document.getElementById("fileTable"),
      issueList: document.getElementById("issueList"),
      tabs: [...document.querySelectorAll(".tab")],
      views: {
        canvas: document.getElementById("canvasView"),
        visuals: document.getElementById("visualsView"),
        model: document.getElementById("modelView"),
        files: document.getElementById("filesView"),
        issues: document.getElementById("issuesView"),
      },
    });
  }

  function bindEvents() {
    els.folderInput.addEventListener("change", (event) => {
      handleFiles(event.target.files);
      event.target.value = "";
    });

    els.fileInput.addEventListener("change", (event) => {
      handleFiles(event.target.files);
      event.target.value = "";
    });

    els.exportButton.addEventListener("click", exportSummary);

    els.pageSelect.addEventListener("change", (event) => {
      state.selectedPageId = event.target.value;
      state.selectedVisualId = null;
      renderCanvas();
      renderPages();
    });

    els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        state.activeTab = tab.dataset.tab;
        renderTabs();
      });
    });

    ["dragenter", "dragover"].forEach((name) => {
      els.dropZone.addEventListener(name, (event) => {
        event.preventDefault();
        els.dropZone.classList.add("dragging");
      });
    });

    ["dragleave", "drop"].forEach((name) => {
      els.dropZone.addEventListener(name, (event) => {
        event.preventDefault();
        els.dropZone.classList.remove("dragging");
      });
    });

    els.dropZone.addEventListener("drop", (event) => {
      handleFiles(event.dataTransfer.files);
    });
  }

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;

    setStatus(`${files.length}件の入力を読み込み中...`);

    try {
      const { entries, issues } = await readUploads(files);
      const project = analyzeProject(entries, issues);
      state.project = project;
      state.selectedPageId = project.report.pages[0]?.id || null;
      state.selectedVisualId = project.report.pages[0]?.visuals[0]?.id || null;
      state.activeTab = project.report.pages.length ? "canvas" : "issues";
      setStatus(makeProjectStatus(project));
      render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.project = {
        uploadedAt: new Date().toISOString(),
        entries: [],
        report: emptyReport(),
        semantic: emptySemantic(),
        issues: [
          {
            level: "error",
            title: "読み込みに失敗しました",
            detail: message,
          },
        ],
      };
      state.activeTab = "issues";
      setStatus("読み込みに失敗しました");
      render();
    }
  }

  async function readUploads(files) {
    const entries = [];
    const issues = [];

    for (const file of files) {
      const path = normalizePath(file.webkitRelativePath || file.name);
      const lower = path.toLowerCase();

      if (lower.endsWith(".pbix")) {
        issues.push({
          level: "warning",
          title: "PBIXは未対応です",
          detail: `${path} はバイナリ形式です。PBIPとして保存したプロジェクト、またはzip化したPBIPフォルダを読み込んでください。`,
        });
        continue;
      }

      if (lower.endsWith(".zip")) {
        if (!window.JSZip) {
          issues.push({
            level: "error",
            title: "zipを展開できません",
            detail: "JSZipを読み込めませんでした。フォルダアップロードを使うか、ネットワーク接続を確認してください。",
          });
          continue;
        }

        const zipEntries = await readZip(file, issues);
        entries.push(...zipEntries);
        continue;
      }

      if (!isTextPath(path)) {
        issues.push({
          level: "info",
          title: "非テキストファイルをスキップしました",
          detail: path,
        });
        continue;
      }

      if (file.size > TEXT_LIMIT) {
        issues.push({
          level: "warning",
          title: "大きすぎるファイルをスキップしました",
          detail: `${path} (${formatBytes(file.size)})`,
        });
        continue;
      }

      entries.push({
        path,
        text: await readText(file),
        size: file.size,
        source: file.name,
      });
    }

    return { entries: dedupeEntries(entries), issues };
  }

  async function readZip(file, issues) {
    const result = [];
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const tasks = [];

    zip.forEach((rawPath, entry) => {
      const path = normalizePath(rawPath);
      if (entry.dir) return;

      if (!isTextPath(path)) {
        return;
      }

      const size = entry._data?.uncompressedSize || 0;
      if (size > TEXT_LIMIT) {
        issues.push({
          level: "warning",
          title: "zip内の大きすぎるファイルをスキップしました",
          detail: `${path} (${formatBytes(size)})`,
        });
        return;
      }

      tasks.push(
        entry.async("string").then((text) => {
          result.push({
            path,
            text,
            size: size || text.length,
            source: file.name,
          });
        }),
      );
    });

    await Promise.all(tasks);
    return result;
  }

  function analyzeProject(entries, incomingIssues = []) {
    const normalizedEntries = dedupeEntries(entries).map((entry) => ({
      ...entry,
      path: normalizePath(entry.path),
      type: classifyFile(entry.path),
      json: null,
      jsonError: null,
    }));

    const issues = [...incomingIssues];
    const jsonByPath = new Map();

    for (const entry of normalizedEntries) {
      if (!isJsonPath(entry.path)) continue;

      try {
        entry.json = JSON.parse(stripBom(entry.text));
        jsonByPath.set(entry.path, entry.json);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        entry.jsonError = detail;
        issues.push({
          level: "error",
          title: "JSONを解析できません",
          detail: `${entry.path}: ${detail}`,
        });
      }
    }

    const report = buildReport(normalizedEntries, jsonByPath);
    const semantic = buildSemantic(normalizedEntries, jsonByPath);
    const dataModel = buildDataModel(semantic);
    hydrateVisualData(report, dataModel);
    const pbipFiles = normalizedEntries.filter((entry) => entry.path.toLowerCase().endsWith(".pbip"));

    if (!pbipFiles.length) {
      issues.push({
        level: "warning",
        title: ".pbipファイルが見つかりません",
        detail: "フォルダ内の .Report / .SemanticModel は解析できますが、プロジェクトマニフェストは確認できていません。",
      });
    }

    if (!report.root) {
      issues.push({
        level: "warning",
        title: "Report定義が見つかりません",
        detail: ".Report/definition 配下のPBIRファイルを含むPBIPプロジェクトを読み込んでください。",
      });
    }

    if (!report.pages.length) {
      issues.push({
        level: "warning",
        title: "ページを検出できません",
        detail: ".Report/definition/pages/*/page.json が見つかりませんでした。",
      });
    }

    if (report.pages.length && !report.visuals.length) {
      issues.push({
        level: "warning",
        title: "ビジュアルを検出できません",
        detail: ".Report/definition/pages/*/visuals/*/visual.json が見つかりませんでした。",
      });
    }

    if (!semantic.tables.length) {
      issues.push({
        level: "info",
        title: "Semantic Modelを検出できません",
        detail: ".SemanticModel/definition 配下のTMDLを含めると、テーブル、列、メジャーを表示できます。",
      });
    }

    if (dataModel.loadedTables.length) {
      issues.push({
        level: "info",
        title: "モデル埋め込みデータから数値を再現しました",
        detail: `${dataModel.loadedTables.map((table) => `${table.name}: ${table.rows}行`).join(" / ")} を Table.FromRows から読み込み、測定値(DAX)を評価しました。`,
      });
    } else {
      const fieldBindingCount = report.visuals.reduce((sum, visual) => sum + visual.roles.length, 0);
      issues.push({
        level: "info",
        title: "メタデータからレイアウトを再現しました",
        detail: `${report.visuals.length}ビジュアル / ${fieldBindingCount}ロールのデータバインド、書式・テーマを反映しています(モデルに埋め込みデータが無いため数値は概形表示です)。`,
      });
    }

    return {
      uploadedAt: new Date().toISOString(),
      entries: normalizedEntries.sort((a, b) => a.path.localeCompare(b.path)),
      pbipFiles,
      report,
      semantic,
      dataModel: { loadedTables: dataModel.loadedTables },
      issues,
    };
  }

  function emptyReport() {
    return {
      root: null,
      meta: {},
      pages: [],
      visuals: [],
      pagesJson: null,
      reportJson: null,
      definitionPbir: null,
    };
  }

  function buildReport(entries, jsonByPath) {
    const report = emptyReport();
    const reportRoots = unique(entries.map((entry) => getTaggedRoot(entry.path, ".Report")).filter(Boolean));
    report.root = reportRoots[0] || null;

    report.definitionPbir = firstJsonEnding(jsonByPath, "/definition.pbir");
    report.reportJson = firstJsonEnding(jsonByPath, "/definition/report.json") || firstJsonEnding(jsonByPath, "/report.json");
    report.pagesJson = firstJsonEnding(jsonByPath, "/definition/pages/pages.json");
    report.meta = extractReportMeta(report.definitionPbir, report.reportJson);
    report.theme = extractTheme(entries, jsonByPath, report.reportJson);

    const pageEntries = entries.filter((entry) => {
      const lower = entry.path.toLowerCase();
      return lower.endsWith("/page.json") && lower.includes("/definition/pages/");
    });

    let pages = [];
    for (const entry of pageEntries) {
      const pageJson = jsonByPath.get(entry.path);
      if (!pageJson) continue;

      const pageDir = dirname(entry.path);
      const fallbackId = basename(pageDir);
      const id = String(pageJson.name || fallbackId);
      const dimensions = getPageDimensions(pageJson);
      const visualPrefix = `${pageDir}/visuals/`.toLowerCase();
      const visualEntries = entries.filter((candidate) => {
        const lower = normalizePath(candidate.path).toLowerCase();
        return lower.endsWith("/visual.json") && lower.startsWith(visualPrefix);
      });

      const visuals = visualEntries
        .map((visualEntry, index) =>
          extractVisual(visualEntry, jsonByPath.get(visualEntry.path), id, dimensions, index),
        )
        .sort((a, b) => (a.position.z || 0) - (b.position.z || 0));

      pages.push({
        id,
        path: entry.path,
        dir: pageDir,
        displayName: String(pageJson.displayName || pageJson.name || fallbackId),
        width: dimensions.width,
        height: dimensions.height,
        type: pageJson.type || pageJson.pageType || "ReportPage",
        visibility: pageJson.visibility || "Visible",
        ordinal: Number.isFinite(Number(pageJson.ordinal)) ? Number(pageJson.ordinal) : null,
        background: extractPageBackground(pageJson),
        visuals,
        json: pageJson,
      });
    }

    if (!pages.length && Array.isArray(report.reportJson?.sections)) {
      const reportPath = findJsonPath(jsonByPath, report.reportJson) || `${report.root || "Report"}/report.json`;
      pages = report.reportJson.sections
        .map((section, index) => extractLegacyPage(section, reportPath, index))
        .filter(Boolean);
    }

    const order = Array.isArray(report.pagesJson?.pageOrder) ? report.pagesJson.pageOrder.map(String) : [];
    pages.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
      if (Number.isFinite(a.ordinal) && Number.isFinite(b.ordinal)) return a.ordinal - b.ordinal;
      return a.displayName.localeCompare(b.displayName);
    });

    report.pages = pages;
    report.visuals = pages.flatMap((page) =>
      page.visuals.map((visual) => ({
        ...visual,
        pageName: page.displayName,
      })),
    );

    return report;
  }

  function extractReportMeta(definitionPbir, reportJson) {
    const meta = {};
    if (definitionPbir) {
      meta.version = definitionPbir.version || definitionPbir.formatVersion || null;
      meta.datasetReference = definitionPbir.datasetReference || definitionPbir.semanticModelReference || null;
      meta.byPath = findFirstScalar(definitionPbir, ["byPath", "path"]);
      meta.byConnection = Boolean(findFirstScalar(definitionPbir, ["connectionString", "pbiServiceModelId"]));
    }

    if (reportJson) {
      meta.theme = reportJson.theme || reportJson.themeCollection || null;
      meta.settings = reportJson.settings || null;
      meta.resourcePackages = Array.isArray(reportJson.resourcePackages)
        ? reportJson.resourcePackages.length
        : null;
    }

    return meta;
  }

  const DEFAULT_THEME_COLORS = [
    "#118DFF", "#12239E", "#E66C37", "#6B007B", "#E044A7",
    "#744EC2", "#D9B300", "#D64550", "#197278", "#1AAB40",
  ];

  function extractTheme(entries, jsonByPath, reportJson) {
    const palettes = [];

    const collectFrom = (themeJson) => {
      const colors = readThemeColors(themeJson);
      if (colors.length) palettes.push(colors);
    };

    // report.json に埋め込まれたカスタムテーマ
    collectFrom(reportJson?.themeCollection?.customTheme);
    collectFrom(reportJson?.themeCollection?.baseTheme);

    // テーマJSONファイル(RegisteredResources / StaticResources / *Theme*.json)
    for (const [path, json] of jsonByPath.entries()) {
      const lower = path.toLowerCase();
      if (!lower.endsWith(".json")) continue;
      if (lower.includes("theme") || lower.includes("/staticresources/") || lower.includes("/registeredresources/")) {
        collectFrom(json);
      }
    }

    const dataColors = palettes.find((colors) => colors.length) || DEFAULT_THEME_COLORS;
    return { dataColors, isDefault: dataColors === DEFAULT_THEME_COLORS };
  }

  function readThemeColors(themeJson) {
    if (!themeJson || typeof themeJson !== "object") return [];
    const candidates = themeJson.dataColors || themeJson.dataColours || themeJson.palette?.dataColors;
    if (Array.isArray(candidates)) {
      return candidates.map((color) => normalizeColor(color)).filter(Boolean);
    }
    return [];
  }

  function extractPageBackground(pageJson) {
    const objects = pageJson?.objects || pageJson?.config?.objects || {};
    const bgProps = firstObjectProps(objects.background);
    const outProps = firstObjectProps(objects.outspace) || firstObjectProps(objects.outspacePane);
    return {
      color: readExprColor(bgProps?.color),
      transparency: readExprNumber(bgProps?.transparency),
      outspaceColor: readExprColor(outProps?.color),
    };
  }

  function extractLegacyPage(section, reportPath, index) {
    if (!section || typeof section !== "object") return null;

    const width = numberOr(section.width, DEFAULT_PAGE.width);
    const height = numberOr(section.height, DEFAULT_PAGE.height);
    const dimensions = { width, height };
    const id = String(section.name || `ReportSection${index + 1}`);
    const containers = Array.isArray(section.visualContainers) ? section.visualContainers : [];

    return {
      id,
      path: `${reportPath}#sections[${index}]`,
      dir: dirname(reportPath),
      displayName: String(section.displayName || section.name || `Page ${index + 1}`),
      width,
      height,
      type: "LegacyReportSection",
      visibility: "Visible",
      ordinal: Number.isFinite(Number(section.ordinal)) ? Number(section.ordinal) : index,
      visuals: containers
        .map((container, visualIndex) =>
          extractLegacyVisual(container, id, dimensions, visualIndex, `${reportPath}#sections[${index}].visualContainers[${visualIndex}]`),
        )
        .filter(Boolean)
        .sort((a, b) => (a.position.z || 0) - (b.position.z || 0)),
      json: section,
    };
  }

  function extractLegacyVisual(container, pageId, pageDimensions, index, path) {
    if (!container || typeof container !== "object") return null;

    const config = parseEmbeddedJson(container.config) || {};
    const filters = parseEmbeddedJson(container.filters) || [];
    const query = parseEmbeddedJson(container.query) || null;
    const dataTransforms = parseEmbeddedJson(container.dataTransforms) || null;
    const root = {
      ...config,
      filters,
      query,
      dataTransforms,
      position: config.layouts?.[0]?.position || {
        x: container.x,
        y: container.y,
        z: container.z,
        width: container.width,
        height: container.height,
      },
      singleVisual: config.singleVisual || {},
      container,
    };

    return extractVisual(
      {
        path,
      },
      root,
      pageId,
      pageDimensions,
      index,
    );
  }

  function getPageDimensions(pageJson) {
    const width = numberOr(pageJson.width ?? pageJson.canvas?.width ?? pageJson.size?.width, DEFAULT_PAGE.width);
    const height = numberOr(pageJson.height ?? pageJson.canvas?.height ?? pageJson.size?.height, DEFAULT_PAGE.height);
    return {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  }

  function extractVisual(entry, json, pageId, pageDimensions, index) {
    const fallbackId = basename(dirname(entry.path));
    const visualRoot = json || {};
    const visualObject = visualRoot.visual || visualRoot.singleVisual || visualRoot.config?.singleVisual || {};
    const type =
      asText(visualObject.visualType) ||
      asText(visualRoot.visualType) ||
      asText(visualRoot.type) ||
      "unknown";
    const position = normalizePosition(
      visualRoot.position || visualRoot.layout?.position || visualRoot.layouts?.[0]?.position,
      pageDimensions,
      index,
    );
    const aliasMap = buildSourceAliasMap(visualRoot);
    const roles = extractRoles(visualObject, visualRoot, aliasMap);
    const fields = extractFields(visualRoot);
    const style = extractVisualStyle(visualObject, visualRoot);
    const textContent = extractRichText(visualObject, visualRoot);
    const explicitTitle = style.title.text || extractTitle(visualRoot);
    const title = explicitTitle || textContent || typeLabel(type);

    return {
      id: String(visualRoot.name || fallbackId),
      pageId,
      path: entry.path,
      title,
      hasExplicitTitle: Boolean(explicitTitle) && style.title.show !== false,
      type,
      typeLabel: typeLabel(type),
      position,
      roles,
      fields,
      style,
      textContent,
      filterCount: countKeyMatches(visualRoot, /filter/i),
      hasQuery: Boolean(visualObject.query || visualRoot.query || visualObject.prototypeQuery),
      jsonStatus: json ? "parsed" : "missing",
    };
  }

  // --- ロール別データバインド解析 ---------------------------------------

  const VALUE_ROLE_NAMES = new Set([
    "y", "y2", "values", "value", "data", "size", "gauge", "weight",
    "target", "min", "max", "x", "playaxis", "saturation",
  ]);

  function classifyRole(roleName, fieldKind) {
    const lower = String(roleName || "").toLowerCase();
    if (fieldKind === "measure" || fieldKind === "aggregation") return "value";
    if (VALUE_ROLE_NAMES.has(lower)) return "value";
    return "category";
  }

  function extractRoles(visualObject, visualRoot, aliasMap) {
    const roles = [];

    const queryState = visualObject?.query?.queryState || visualRoot?.query?.queryState;
    if (queryState && typeof queryState === "object") {
      for (const [roleName, def] of Object.entries(queryState)) {
        const projections = Array.isArray(def?.projections) ? def.projections : [];
        const fields = projections
          .map((projection) => projectionToField(projection, aliasMap))
          .filter(Boolean);
        if (fields.length) roles.push({ role: roleName, fields });
      }
    }

    if (!roles.length) {
      const proto = visualObject?.prototypeQuery || visualRoot?.prototypeQuery;
      const transforms = visualObject?.dataTransforms || visualRoot?.dataTransforms;
      if (proto && Array.isArray(proto.Select)) {
        const protoAlias = buildSourceAliasMap(proto);
        const byRole = new Map();
        proto.Select.forEach((select, selectIndex) => {
          const field = projectionToField({ field: select, nativeQueryRef: select?.Name }, protoAlias);
          if (!field) return;
          const roleName = legacySelectRole(transforms, selectIndex) || (field.kind === "measure" ? "Values" : "Category");
          if (!byRole.has(roleName)) byRole.set(roleName, []);
          byRole.get(roleName).push(field);
        });
        for (const [role, fields] of byRole.entries()) roles.push({ role, fields });
      }
    }

    return roles;
  }

  function legacySelectRole(transforms, selectIndex) {
    const selects = transforms?.selects;
    if (!Array.isArray(selects)) return null;
    const entry = selects[selectIndex];
    const roleObj = entry?.roles;
    if (roleObj && typeof roleObj === "object") {
      const active = Object.keys(roleObj).find((key) => roleObj[key]);
      if (active) return active;
    }
    return null;
  }

  const AGG_FUNCTIONS = { 0: "Sum", 1: "Avg", 2: "Count", 3: "Min", 4: "Max", 5: "CountNonNull", 6: "Median", 7: "StdDev", 8: "Var" };

  function projectionToField(projection, aliasMap) {
    if (!projection || typeof projection !== "object") return null;
    const field = projection.field || projection;

    let kind = "column";
    let inner = null;
    let agg = null;
    if (field.Measure) { kind = "measure"; inner = field.Measure; }
    else if (field.Aggregation) {
      kind = "aggregation";
      inner = field.Aggregation.Expression?.Column || field.Aggregation.Expression || field.Aggregation;
      agg = AGG_FUNCTIONS[field.Aggregation.Function] || "Sum";
    }
    else if (field.Column) { kind = "column"; inner = field.Column; }
    else if (field.HierarchyLevel) { kind = "hierarchy"; inner = field.HierarchyLevel; }
    else if (field.Hierarchy) { kind = "hierarchy"; inner = field.Hierarchy; }
    else { inner = field; }

    let table = "";
    let name = "";
    if (inner) {
      const resolved = fieldFromExpression(inner, aliasMap);
      table = cleanFieldName(resolved.table || "");
      name = cleanFieldName(resolved.name || "");
    }

    if (!name && projection.nativeQueryRef) name = cleanFieldName(projection.nativeQueryRef);
    if (projection.queryRef && (!table || !name)) {
      const parts = String(projection.queryRef).split(".");
      if (parts.length >= 2) {
        table = table || cleanFieldName(parts[0]);
        name = name || cleanFieldName(parts.slice(1).join("."));
      }
    }
    if (!name) return null;

    const label = table ? `${table}[${name}]` : name;
    return {
      kind,
      table,
      name,
      label,
      agg,
      display: cleanFieldName(projection.displayName || projection.nativeQueryRef || name),
      queryRef: projection.queryRef || "",
    };
  }

  // --- 書式・リッチテキスト解析 ----------------------------------------

  function extractVisualStyle(visualObject, visualRoot) {
    const containerObjects =
      visualObject?.visualContainerObjects || visualRoot?.visualContainerObjects || visualObject?.vcObjects || {};
    const objects = visualObject?.objects || visualRoot?.objects || visualRoot?.config?.objects || {};

    const titleProps = firstObjectProps(containerObjects.title) || firstObjectProps(objects.title);
    const titleText = readExprString(titleProps?.text);
    const titleShow = readExprBool(titleProps?.show);

    const bgProps = firstObjectProps(containerObjects.background) || firstObjectProps(objects.background);
    const borderProps = firstObjectProps(containerObjects.border) || firstObjectProps(objects.border);
    const fillProps = firstObjectProps(objects.fill);

    return {
      fill: readExprColor(fillProps?.fillColor) || readExprColor(fillProps?.color),
      title: {
        text: isDisplayText(titleText) ? titleText : "",
        color: readExprColor(titleProps?.fontColor),
        align: readExprString(titleProps?.alignment) || readExprString(titleProps?.titleAlignment) || "",
        show: titleShow !== false,
      },
      background: {
        color: readExprColor(bgProps?.color),
        show: readExprBool(bgProps?.show) !== false,
        transparency: readExprNumber(bgProps?.transparency),
      },
      border: {
        color: readExprColor(borderProps?.color),
        show: readExprBool(borderProps?.show) === true,
        radius: readExprNumber(borderProps?.radius),
      },
      dataColors: extractDataColors(objects),
    };
  }

  function extractDataColors(objects) {
    const colors = [];
    const dataPoint = objects?.dataPoint;
    if (Array.isArray(dataPoint)) {
      for (const item of dataPoint) {
        const color = readExprColor(item?.properties?.fill);
        if (color) colors.push(color);
      }
    }
    return colors;
  }

  function firstObjectProps(value) {
    if (Array.isArray(value)) return value[0]?.properties || value[0] || null;
    if (value && typeof value === "object") return value.properties || value;
    return null;
  }

  function readExpr(prop) {
    if (prop == null) return undefined;
    if (typeof prop !== "object") return prop;
    const expr = prop.expr || prop.Expr || prop;
    if (expr && typeof expr === "object") {
      if (expr.Literal && "Value" in expr.Literal) return expr.Literal.Value;
      if ("Value" in expr) return expr.Value;
    }
    return undefined;
  }

  function readExprString(prop) {
    const value = readExpr(prop);
    return value == null ? "" : cleanLiteral(String(value));
  }

  function readExprBool(prop) {
    const value = readExpr(prop);
    if (value == null) return undefined;
    if (typeof value === "boolean") return value;
    return /^true$/i.test(String(value).replace(/'/g, ""));
  }

  function readExprNumber(prop) {
    const value = readExpr(prop);
    const number = Number(String(value ?? "").replace(/['D]/g, ""));
    return Number.isFinite(number) ? number : undefined;
  }

  function readExprColor(prop) {
    if (prop == null) return "";
    if (typeof prop === "string") return normalizeColor(prop);
    const direct = readExpr(prop);
    if (typeof direct === "string" && direct) return normalizeColor(direct);
    // solid color expressions: { solid: { color: { expr: { Literal: { Value: "'#RRGGBB'" } } } } }
    const solid = prop.solid || prop.Solid;
    if (solid) {
      const colorValue = readExpr(solid.color || solid.Color);
      if (typeof colorValue === "string" && colorValue) return normalizeColor(colorValue);
    }
    let found = "";
    walk(prop, (node) => {
      if (found) return;
      if (typeof node === "string" && /^'?#[0-9a-f]{3,8}'?$/i.test(node.trim())) {
        found = normalizeColor(node);
      }
    });
    return found;
  }

  function normalizeColor(value) {
    const text = cleanLiteral(String(value || "")).trim();
    return /^#[0-9a-f]{3,8}$/i.test(text) ? text : "";
  }

  function extractRichText(visualObject, visualRoot) {
    // 新PBIR textbox: visual.objects.general[].properties.paragraphs
    const objects = visualObject?.objects || visualRoot?.objects || {};
    const paragraphHosts = [objects.general, objects.text, objects.textBox];
    for (const host of paragraphHosts) {
      const props = firstObjectProps(host);
      const text = paragraphsToText(props?.paragraphs);
      if (text) return text.slice(0, 240);
    }
    return extractTextContent(visualRoot);
  }

  function paragraphsToText(paragraphs) {
    if (!Array.isArray(paragraphs)) return "";
    return paragraphs
      .flatMap((paragraph) => paragraph?.textRuns || [])
      .map((run) => run?.value ?? readExpr(run?.value) ?? "")
      .join("")
      .trim();
  }

  function normalizePosition(rawPosition, pageDimensions, index) {
    const fallbackWidth = Math.round(pageDimensions.width * 0.22);
    const fallbackHeight = Math.round(pageDimensions.height * 0.22);
    const column = index % 4;
    const row = Math.floor(index / 4);
    const fallback = {
      x: 30 + column * (fallbackWidth + 22),
      y: 28 + row * (fallbackHeight + 22),
      width: fallbackWidth,
      height: fallbackHeight,
      z: index,
      fallback: true,
    };

    if (!rawPosition || typeof rawPosition !== "object") return fallback;

    const width = numberOr(rawPosition.width ?? rawPosition.w, fallbackWidth);
    const height = numberOr(rawPosition.height ?? rawPosition.h, fallbackHeight);
    const x = numberOr(rawPosition.x ?? rawPosition.left, fallback.x);
    const y = numberOr(rawPosition.y ?? rawPosition.top, fallback.y);
    const z = numberOr(rawPosition.z ?? rawPosition.zIndex ?? rawPosition.tabOrder, index);

    return {
      x,
      y,
      width: Math.max(8, width),
      height: Math.max(8, height),
      z,
      fallback: false,
    };
  }

  function extractTitle(root) {
    let best = null;

    walk(root, (node, key) => {
      if (best || !node || typeof node !== "object") return;
      if (String(key).toLowerCase() !== "title") return;

      const text =
        findFirstScalar(node, ["Value", "value", "text", "Text"]) ||
        findFirstScalar(node, ["Literal"]);
      if (typeof text === "string" && text.length < 120) {
        const candidate = cleanLiteral(text);
        if (isDisplayText(candidate)) best = candidate;
      }
    });

    return best;
  }

  function isDisplayText(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (/^(true|false)$/i.test(text)) return false;
    if (/^-?\d+(?:\.\d+)?[DLM]?$/i.test(text)) return false;
    if (/^#[0-9a-f]{3,8}$/i.test(text)) return false;
    return true;
  }

  function extractTextContent(root) {
    let best = null;

    walk(root, (node, key) => {
      if (best || String(key).toLowerCase() !== "paragraphs") return;

      const raw = findFirstScalar(node, ["Value", "value"]);
      if (typeof raw !== "string") return;

      const parsed = parseEmbeddedJson(cleanLiteral(raw));
      const text = parsed?.paragraphs
        ?.flatMap((paragraph) => paragraph.textRuns || [])
        .map((run) => run.value)
        .join("")
        .trim();

      if (text) best = text.slice(0, 140);
    });

    return best;
  }

  function extractFields(root) {
    const fields = [];
    const seen = new Set();
    const aliasMap = buildSourceAliasMap(root);

    function add(kind, table, name, role = "") {
      if (!name) return;
      const cleanTable = cleanFieldName(table || "");
      const cleanName = cleanFieldName(name);
      if (!cleanName || cleanName.length > 160) return;
      const label = cleanTable ? `${cleanTable}[${cleanName}]` : cleanName;
      const key = `${kind}:${label}:${role}`;
      if (seen.has(key)) return;
      seen.add(key);
      fields.push({
        kind,
        table: cleanTable,
        name: cleanName,
        role: role || "",
        label,
      });
    }

    walk(root, (node, key) => {
      if (!node || typeof node !== "object") return;

      if (node.Column && typeof node.Column === "object") {
        const field = fieldFromExpression(node.Column, aliasMap);
        add("column", field.table, field.name, String(key || ""));
      }

      if (node.Measure && typeof node.Measure === "object") {
        const field = fieldFromExpression(node.Measure, aliasMap);
        add("measure", field.table, field.name, String(key || ""));
      }

      if (node.Aggregation && typeof node.Aggregation === "object") {
        const field = fieldFromExpression(node.Aggregation, aliasMap);
        add("aggregation", field.table, field.name, String(key || ""));
      }

      if (node.Hierarchy && typeof node.Hierarchy === "object") {
        const field = fieldFromExpression(node.Hierarchy, aliasMap);
        add("hierarchy", field.table, field.name, String(key || ""));
      }
    });

    const textRefs = [];
    walk(root, (node) => {
      if (typeof node === "string" && node.length < 800) {
        collectTextFieldRefs(node, textRefs);
      }
    });

    for (const ref of textRefs) {
      add(ref.kind, ref.table, ref.name, ref.role);
      if (fields.length >= 120) break;
    }

    return fields.slice(0, 120);
  }

  function buildSourceAliasMap(root) {
    const map = new Map();

    walk(root, (node) => {
      if (!node || typeof node !== "object" || !Array.isArray(node.From)) return;
      for (const source of node.From) {
        if (source?.Name && source?.Entity) {
          map.set(String(source.Name), String(source.Entity));
        }
      }
    });

    return map;
  }

  function fieldFromExpression(expression, aliasMap = new Map()) {
    const expressionRoot = expression.Expression || expression;
    const directColumn = expression.Expression?.Column || expression.Column;
    const directMeasure = expression.Expression?.Measure || expression.Measure;
    const directHierarchy = expression.Expression?.Hierarchy || expression.Hierarchy;

    if (directColumn && directColumn !== expression) return fieldFromExpression(directColumn, aliasMap);
    if (directMeasure && directMeasure !== expression) return fieldFromExpression(directMeasure, aliasMap);
    if (directHierarchy && directHierarchy !== expression) return fieldFromExpression(directHierarchy, aliasMap);

    const rawTable =
      expressionRoot.SourceRef?.Entity ||
      expressionRoot.SourceRef?.Source ||
      expression.Entity ||
      findFirstScalar(expressionRoot, ["Entity"]);

    return {
      table: aliasMap.get(String(rawTable)) || rawTable,
      name:
        expression.Property ||
        expression.Name ||
        findFirstScalar(expression, ["Property"]) ||
        findFirstScalar(expression, ["Name"]),
    };
  }

  function collectTextFieldRefs(text, refs) {
    const patterns = [
      /'([^']+)'\[([^\]]+)\]/g,
      /\b([A-Za-z_][A-Za-z0-9_ .-]{0,80})\[([^\]]{1,120})\]/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) {
        refs.push({
          kind: /measure/i.test(text.slice(Math.max(0, match.index - 30), match.index + 30))
            ? "measure"
            : "field",
          table: match[1],
          name: match[2],
          role: "expression",
        });
      }
    }
  }

  function buildSemantic(entries, jsonByPath) {
    const semantic = emptySemantic();
    const semanticRoots = unique(entries.map((entry) => getTaggedRoot(entry.path, ".SemanticModel")).filter(Boolean));
    semantic.root = semanticRoots[0] || null;

    const tableMap = new Map();
    const addTable = (incoming) => {
      const name = incoming.name || "Unknown";
      if (!tableMap.has(name)) {
        tableMap.set(name, {
          name,
          path: incoming.path || "",
          columns: [],
          measures: [],
          hierarchies: [],
          partitions: [],
          relationships: [],
        });
      }

      const target = tableMap.get(name);
      for (const key of ["columns", "measures", "hierarchies", "partitions", "relationships"]) {
        mergeNamedItems(target[key], incoming[key] || []);
      }
      if (incoming.data && !target.data) target.data = incoming.data;
    };

    for (const entry of entries.filter((item) => item.path.toLowerCase().endsWith(".tmdl"))) {
      const parsed = parseTmdl(entry.text, inferTableNameFromPath(entry.path), entry.path);
      const inline = extractInlineData(entry.text);
      if (inline && parsed.tables[0]) parsed.tables[0].data = inline;
      if (parsed.tables.length) {
        parsed.tables.forEach(addTable);
      }
      semantic.relationships.push(...parsed.relationships);
    }

    for (const [path, json] of jsonByPath.entries()) {
      if (!path.toLowerCase().endsWith("model.bim")) continue;
      const tables = json.model?.tables || json.tables || [];
      for (const table of tables) {
        addTable({
          name: table.name,
          path,
          columns: (table.columns || []).map((column) => ({
            name: column.name,
            dataType: column.dataType || column.type || "",
          })),
          measures: (table.measures || []).map((measure) => ({
            name: measure.name,
            expression: Array.isArray(measure.expression)
              ? measure.expression.join("\n")
              : measure.expression || "",
          })),
          hierarchies: (table.hierarchies || []).map((hierarchy) => ({ name: hierarchy.name })),
          partitions: (table.partitions || []).map((partition) => ({ name: partition.name })),
        });
      }
    }

    semantic.tables = [...tableMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    return semantic;
  }

  function emptySemantic() {
    return {
      root: null,
      tables: [],
      relationships: [],
    };
  }

  function parseTmdl(text, fallbackName, path) {
    const result = { tables: [], relationships: [] };
    let currentTable = null;
    let currentItem = null;

    function ensureTable() {
      if (!currentTable) {
        currentTable = {
          name: fallbackName || "Model",
          path,
          columns: [],
          measures: [],
          hierarchies: [],
          partitions: [],
          relationships: [],
        };
        result.tables.push(currentTable);
      }
      return currentTable;
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;

      const tableName = readTmdlDeclaration(line, "table");
      if (tableName) {
        currentTable = {
          name: tableName,
          path,
          columns: [],
          measures: [],
          hierarchies: [],
          partitions: [],
          relationships: [],
        };
        result.tables.push(currentTable);
        currentItem = null;
        continue;
      }

      const columnName = readTmdlDeclaration(line, "column");
      if (columnName) {
        currentItem = { type: "column", item: { name: columnName, dataType: "", formatString: "" } };
        ensureTable().columns.push(currentItem.item);
        continue;
      }

      const measureName = readTmdlDeclaration(line, "measure");
      if (measureName) {
        currentItem = {
          type: "measure",
          item: {
            name: measureName,
            expression: readAfterEquals(line),
            formatString: "",
          },
        };
        ensureTable().measures.push(currentItem.item);
        continue;
      }

      const hierarchyName = readTmdlDeclaration(line, "hierarchy");
      if (hierarchyName) {
        currentItem = { type: "hierarchy", item: { name: hierarchyName } };
        ensureTable().hierarchies.push(currentItem.item);
        continue;
      }

      const partitionName = readTmdlDeclaration(line, "partition");
      if (partitionName) {
        currentItem = { type: "partition", item: { name: partitionName } };
        ensureTable().partitions.push(currentItem.item);
        continue;
      }

      const relationshipName = readTmdlDeclaration(line, "relationship");
      if (relationshipName) {
        result.relationships.push({ name: relationshipName, path });
        currentItem = null;
        continue;
      }

      if (currentItem && /^dataType\s*:/i.test(line)) {
        currentItem.item.dataType = line.split(":").slice(1).join(":").trim();
      }

      if (currentItem && /^formatString\s*:/i.test(line)) {
        currentItem.item.formatString = cleanLiteral(line.split(":").slice(1).join(":").trim());
      }

      if (currentItem?.type === "measure" && !currentItem.item.expression && /^\s*=/.test(rawLine)) {
        currentItem.item.expression = rawLine.replace(/^\s*=\s*/, "").trim();
      }
    }

    if (!result.tables.length && fallbackName && /(?:column|measure|partition|hierarchy)\s+/i.test(text)) {
      ensureTable();
    }

    return result;
  }

  // --- TMDLインラインデータ(Table.FromRows)解析 -----------------------

  function extractInlineData(text) {
    const anchor = text.indexOf("Table.FromRows");
    if (anchor < 0) return null;

    const rowsStart = text.indexOf("{", anchor);
    if (rowsStart < 0) return null;
    const rowsBlock = readBalanced(text, rowsStart, "{", "}");
    if (!rowsBlock) return null;

    const afterRows = rowsStart + rowsBlock.length;
    const typeIdx = text.indexOf("type table", afterRows);
    let columns = [];
    if (typeIdx >= 0) {
      const colStart = text.indexOf("[", typeIdx);
      const colBlock = readBalanced(text, colStart, "[", "]");
      if (colBlock) columns = parseTypeTable(colBlock);
    }

    const rows = parseRowList(rowsBlock);
    if (!rows.length) return null;

    if (!columns.length) {
      const width = Math.max(...rows.map((row) => row.length));
      columns = Array.from({ length: width }, (_, index) => ({ name: `Column${index + 1}`, type: "" }));
    }

    const records = rows.map((values) => {
      const record = {};
      columns.forEach((column, index) => {
        record[column.name] = coerceValue(values[index], column.type);
      });
      return record;
    });

    return { columns, records };
  }

  function readBalanced(text, start, open, close) {
    if (start < 0 || text[start] !== open) return "";
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === '"') {
          if (text[index + 1] === '"') { index += 1; continue; }
          inString = false;
        }
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
  }

  function splitTopLevel(inner, separator = ",") {
    const parts = [];
    let depth = 0;
    let inString = false;
    let current = "";
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index];
      if (inString) {
        current += char;
        if (char === '"') {
          if (inner[index + 1] === '"') { current += inner[index + 1]; index += 1; continue; }
          inString = false;
        }
        continue;
      }
      if (char === '"') { inString = true; current += char; continue; }
      if (char === "{" || char === "[" || char === "(") depth += 1;
      else if (char === "}" || char === "]" || char === ")") depth -= 1;
      if (char === separator && depth === 0) { parts.push(current); current = ""; continue; }
      current += char;
    }
    if (current.trim() !== "" || parts.length) parts.push(current);
    return parts;
  }

  function parseRowList(rowsBlock) {
    const inner = rowsBlock.slice(1, -1); // 外側の { } を除去
    return splitTopLevel(inner)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith("{"))
      .map((rowText) => splitTopLevel(rowText.slice(1, -1)).map((cell) => parseMValue(cell.trim())));
  }

  function parseTypeTable(colBlock) {
    const inner = colBlock.slice(1, -1);
    return splitTopLevel(inner)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        const rawName = eq >= 0 ? part.slice(0, eq) : part;
        const type = eq >= 0 ? part.slice(eq + 1).trim() : "";
        return { name: cleanMName(rawName), type };
      });
  }

  function cleanMName(value) {
    let text = String(value || "").trim();
    if (text.startsWith('#"') && text.endsWith('"')) return text.slice(2, -1);
    if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
    return text;
  }

  function parseMValue(token) {
    const text = token.trim();
    if (text === "" || /^null$/i.test(text)) return null;
    if (/^true$/i.test(text)) return true;
    if (/^false$/i.test(text)) return false;
    if (text.startsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
    return text;
  }

  function coerceValue(value, type) {
    if (value == null) return null;
    if (/Int64|number|Decimal|Double|Currency|Percentage/i.test(type)) {
      const number = Number(value);
      return Number.isFinite(number) ? number : value;
    }
    return value;
  }

  // --- 簡易DAX測定値の評価 --------------------------------------------

  function buildDataModel(semantic) {
    const byName = new Map();
    const loadedTables = [];
    for (const table of semantic.tables) {
      if (!table.data?.records?.length) continue;
      const measures = new Map((table.measures || []).map((measure) => [measure.name, measure]));
      const model = {
        name: table.name,
        columns: table.data.columns,
        records: table.data.records,
        measures,
      };
      byName.set(table.name, model);
      byName.set(normalizeName(table.name), model);
      loadedTables.push({ name: table.name, rows: table.data.records.length });
    }
    return { byName, loadedTables };
  }

  function normalizeName(value) {
    return String(value || "").toLowerCase().replace(/[\s_'"\[\]]+/g, "");
  }

  function resolveColumn(table, name) {
    if (!table) return null;
    const target = normalizeName(name);
    const column = table.columns.find((item) => normalizeName(item.name) === target);
    return column ? column.name : null;
  }

  function aggregate(records, columnName, func) {
    const values = records
      .map((record) => record[columnName])
      .filter((value) => value !== "" && value != null);
    const numbers = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    switch ((func || "sum").toLowerCase()) {
      case "count": return values.length;
      case "countrows": return records.length;
      case "distinctcount": return new Set(values).size;
      case "average":
      case "avg": return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
      case "min": return numbers.length ? Math.min(...numbers) : 0;
      case "max": return numbers.length ? Math.max(...numbers) : 0;
      default: return numbers.reduce((a, b) => a + b, 0);
    }
  }

  function evaluateDax(expression, records, table) {
    if (!expression) return null;
    let body = String(expression).trim();

    const calc = body.match(/^CALCULATE\s*\(([\s\S]*)\)$/i);
    let rows = records;
    if (calc) {
      const args = splitTopLevel(calc[1]);
      body = args[0].trim();
      for (const filterText of args.slice(1)) {
        const filter = parseDaxFilter(filterText, table);
        if (filter) rows = rows.filter((record) => matchDaxFilter(record, filter));
      }
    }

    const agg = body.match(/^(COUNTROWS|DISTINCTCOUNT|SUM|MIN|MAX|AVERAGE)\s*\(([\s\S]*)\)$/i);
    if (!agg) return null;
    const func = agg[1].toUpperCase();
    if (func === "COUNTROWS") return rows.length;

    const columnName = resolveColumn(table, parseColumnRef(agg[2]));
    if (!columnName) return null;
    return aggregate(rows, columnName, func === "DISTINCTCOUNT" ? "distinctcount" : func);
  }

  function parseColumnRef(text) {
    const match = String(text).match(/\[([^\]]+)\]/);
    if (match) return match[1];
    return String(text).replace(/['"]/g, "").trim();
  }

  function parseDaxFilter(text, table) {
    const match = String(text).match(/\[([^\]]+)\]\s*(=|<>|>=|<=|>|<)\s*(.+)$/);
    if (!match) return null;
    const column = resolveColumn(table, match[1]);
    if (!column) return null;
    let rawValue = match[3].trim();
    let value;
    if (/^".*"$/.test(rawValue)) value = rawValue.slice(1, -1).replace(/""/g, '"');
    else if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
    else value = rawValue.replace(/^['"]|['"]$/g, "");
    return { column, op: match[2], value };
  }

  function matchDaxFilter(record, filter) {
    const cell = record[filter.column];
    const left = typeof filter.value === "number" ? Number(cell) : String(cell ?? "");
    switch (filter.op) {
      case "=": return left == filter.value;
      case "<>": return left != filter.value;
      case ">": return left > filter.value;
      case "<": return left < filter.value;
      case ">=": return left >= filter.value;
      case "<=": return left <= filter.value;
      default: return true;
    }
  }

  function formatMeasureValue(value, formatString) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    if (!formatString) return groupThousands(roundTo(number, 2));

    const literals = [...formatString.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("");
    const core = formatString.replace(/"[^"]*"/g, "").trim();
    const decimalPart = core.split(".")[1] || "";
    const decimals = (decimalPart.match(/[0#]/g) || []).length;
    const grouped = core.includes(",");
    const percent = core.includes("%");

    let scaled = percent ? number * 100 : number;
    let text = scaled.toFixed(decimals);
    if (grouped) text = groupThousands(text);
    return `${text}${percent ? "%" : ""}${literals}`;
  }

  function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return String(Math.round(value * factor) / factor);
  }

  function groupThousands(numericText) {
    const [intPart, decPart] = String(numericText).split(".");
    const sign = intPart.startsWith("-") ? "-" : "";
    const digits = intPart.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}${digits}${decPart != null ? `.${decPart}` : ""}`;
  }

  // --- ビジュアルへ実データを付与 --------------------------------------

  function hydrateVisualData(report, dataModel) {
    if (!dataModel.byName.size) return;
    const cache = new Map();
    for (const page of report.pages) {
      for (const visual of page.visuals) {
        const data = computeVisualData(visual, dataModel);
        visual.data = data;
        cache.set(`${page.id}/${visual.id}`, data);
      }
    }
    for (const visual of report.visuals) {
      visual.data = cache.get(`${visual.pageId}/${visual.id}`) || null;
    }
  }

  function roleFieldsByKind(visual, kind) {
    const result = [];
    for (const role of visual.roles || []) {
      for (const field of role.fields) {
        if (classifyRole(role.role, field.kind) === kind) result.push(field);
      }
    }
    return result;
  }

  function resolveTableFor(fields, dataModel) {
    for (const field of fields) {
      if (!field?.table) continue;
      const table = dataModel.byName.get(field.table) || dataModel.byName.get(normalizeName(field.table));
      if (table) return table;
    }
    if (dataModel.loadedTables.length === 1) {
      return dataModel.byName.get(dataModel.loadedTables[0].name);
    }
    return null;
  }

  function evaluateField(field, records, table) {
    if (!field) return null;
    if (field.kind === "measure") {
      const measure = table.measures.get(field.name);
      if (measure) return { value: evaluateDax(measure.expression, records, table), format: measure.formatString };
      return null;
    }
    const columnName = resolveColumn(table, field.name);
    if (!columnName) return null;
    return { value: aggregate(records, columnName, field.agg), format: "" };
  }

  function computeVisualData(visual, dataModel) {
    const categories = roleFieldsByKind(visual, "category");
    const values = roleFieldsByKind(visual, "value");
    if (!categories.length && !values.length) return null;

    const type = visual.type.toLowerCase();
    const table = resolveTableFor([...values, ...categories], dataModel);
    if (!table) return null;

    const valueField = values[0];
    const categoryField = categories[0];
    const categoryColumn = categoryField ? resolveColumn(table, categoryField.name) : null;

    // テーブル / マトリックス
    if (type.includes("table") || type.includes("pivot") || type.includes("matrix")) {
      const columnFields = [...categories, ...values.filter((field) => field.kind !== "measure"), ...values.filter((field) => field.kind === "measure")];
      const plain = columnFields.filter((field) => field.kind !== "measure");
      const columnNames = plain.map((field) => resolveColumn(table, field.name) || field.name);
      const rows = table.records.slice(0, 8).map((record) => columnNames.map((name) => formatCell(record[name])));
      return { kind: "table", columns: plain.map((field) => field.display), rows, total: table.records.length };
    }

    // スライサー
    if (type.includes("slicer")) {
      const items = [];
      const seen = new Set();
      for (const record of table.records) {
        const text = String(categoryColumn ? record[categoryColumn] ?? "" : "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
        if (items.length >= 14) break;
      }
      return { kind: "slicer", field: categoryField?.display || "", items };
    }

    // カード / KPI(カテゴリなし)
    if ((type.includes("card") || type.includes("kpi") || type.includes("gauge") || type.includes("multirow")) || (!categoryColumn && valueField)) {
      const evaluated = valueField ? evaluateField(valueField, table.records, table) : null;
      if (!evaluated) return null;
      return { kind: "card", value: evaluated.value, text: formatMeasureValue(evaluated.value, evaluated.format), label: valueField.display };
    }

    // カテゴリ系チャート
    if (categoryColumn && valueField) {
      const groups = new Map();
      for (const record of table.records) {
        const label = String(record[categoryColumn] ?? "").trim() || "(空白)";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(record);
      }
      let series = [...groups.entries()].map(([label, records]) => {
        const evaluated = evaluateField(valueField, records, table);
        return { label, value: Number(evaluated?.value) || 0, format: evaluated?.format || "" };
      });
      if (!type.includes("line") && !type.includes("area")) {
        series.sort((a, b) => b.value - a.value);
      }
      series = series.slice(0, 12);
      const max = Math.max(1, ...series.map((point) => Math.abs(point.value)));
      return {
        kind: "category",
        categoryLabel: categoryField.display,
        valueLabel: valueField.display,
        format: series[0]?.format || "",
        max,
        series,
      };
    }

    return null;
  }

  function formatCell(value) {
    if (value == null) return "";
    if (typeof value === "number") return groupThousands(roundTo(value, 4));
    return String(value);
  }

  function render() {
    renderTabs();
    renderMetrics();
    renderPages();
    renderCanvas();
    renderVisualTable();
    renderModelExplorer();
    renderFileTable();
    renderIssues();
    els.exportButton.disabled = !state.project;
  }

  function renderTabs() {
    const hasProject = Boolean(state.project);
    els.emptyState.classList.toggle("active", !hasProject);

    for (const tab of els.tabs) {
      tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
    }

    for (const [name, view] of Object.entries(els.views)) {
      view.classList.toggle("active", hasProject && name === state.activeTab);
    }
  }

  function renderMetrics() {
    const project = state.project;
    const metrics = project
      ? [
          ["ページ", project.report.pages.length],
          ["ビジュアル", project.report.visuals.length],
          ["テーブル", project.semantic.tables.length],
          ["ファイル", project.entries.length],
        ]
      : [
          ["ページ", 0],
          ["ビジュアル", 0],
          ["テーブル", 0],
          ["ファイル", 0],
        ];

    els.summaryMetrics.innerHTML = metrics
      .map(
        ([label, value]) => `
          <div class="metric">
            <div class="metric-value">${escapeHtml(String(value))}</div>
            <div class="metric-label">${escapeHtml(label)}</div>
          </div>
        `,
      )
      .join("");
  }

  function renderPages() {
    const pages = state.project?.report.pages || [];

    if (!pages.length) {
      els.pageList.innerHTML = `<div class="empty-table">ページなし</div>`;
      return;
    }

    els.pageList.innerHTML = pages
      .map(
        (page) => `
          <button class="page-item ${page.id === state.selectedPageId ? "active" : ""}" type="button" data-page="${escapeAttribute(page.id)}">
            <div class="page-name">${escapeHtml(page.displayName)}</div>
            <div class="page-meta">${page.visuals.length} visuals / ${Math.round(page.width)} x ${Math.round(page.height)}</div>
          </button>
        `,
      )
      .join("");

    els.pageList.querySelectorAll(".page-item").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedPageId = button.dataset.page;
        state.selectedVisualId = getCurrentPage()?.visuals[0]?.id || null;
        renderPages();
        renderCanvas();
      });
    });
  }

  function renderCanvas() {
    const page = getCurrentPage();
    els.pageSelect.innerHTML = "";
    els.reportCanvas.innerHTML = "";
    els.visualInspector.innerHTML = "";

    const pages = state.project?.report.pages || [];
    for (const candidate of pages) {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.displayName;
      option.selected = candidate.id === state.selectedPageId;
      els.pageSelect.append(option);
    }

    if (!page) {
      els.canvasMeta.textContent = "ページがありません";
      els.reportCanvas.style.aspectRatio = `${DEFAULT_PAGE.width} / ${DEFAULT_PAGE.height}`;
      return;
    }

    els.canvasMeta.textContent = `${Math.round(page.width)} x ${Math.round(page.height)} / ${page.visuals.length} visuals`;
    els.reportCanvas.style.aspectRatio = `${page.width} / ${page.height}`;
    els.reportCanvas.style.background = page.background?.color || "";

    const theme = getTheme();

    for (const visual of page.visuals) {
      const style = visual.style || {};
      const box = document.createElement("button");
      box.type = "button";
      box.className = `visual-box ${visual.id === state.selectedVisualId ? "selected" : ""}`;
      box.style.left = `${percent(visual.position.x, page.width)}%`;
      box.style.top = `${percent(visual.position.y, page.height)}%`;
      box.style.width = `${percent(visual.position.width, page.width)}%`;
      box.style.height = `${percent(visual.position.height, page.height)}%`;
      box.style.zIndex = String(Math.max(1, Math.round(visual.position.z || 0) + 1));

      const boxBackground =
        style.background?.color || (visual.type.toLowerCase().includes("shape") ? style.fill : "");
      if (boxBackground) box.style.background = boxBackground;
      if (style.border?.show && style.border.color) box.style.borderColor = style.border.color;
      if (Number.isFinite(style.border?.radius)) box.style.borderRadius = `${style.border.radius}px`;

      const showTitle = visual.hasExplicitTitle;
      const titleStyle = [
        style.title?.color ? `color:${style.title.color}` : "",
        style.title?.align ? `text-align:${cssAlign(style.title.align)}` : "",
      ].filter(Boolean).join(";");

      box.title = `${visual.typeLabel} / ${visual.fields.length} fields`;
      box.innerHTML = `
        ${showTitle ? `<div class="visual-title" style="${titleStyle}">${escapeHtml(visual.title)}</div>` : ""}
        <div class="visual-body">${renderVisualPreview(visual, theme)}</div>
      `;
      box.addEventListener("click", () => {
        state.selectedVisualId = visual.id;
        renderCanvas();
      });
      els.reportCanvas.append(box);
    }

    renderInspector(page);
  }

  function getTheme() {
    return state.project?.report?.theme?.dataColors || DEFAULT_THEME_COLORS;
  }

  function cssAlign(align) {
    const value = String(align).toLowerCase();
    if (value.includes("right")) return "right";
    if (value.includes("center")) return "center";
    return "left";
  }

  function roleFieldsOf(visual, kind) {
    const result = [];
    for (const role of visual.roles || []) {
      for (const field of role.fields) {
        if (classifyRole(role.role, field.kind) === kind) result.push(field);
      }
    }
    return result;
  }

  function renderVisualPreview(visual, theme = DEFAULT_THEME_COLORS) {
    const type = visual.type.toLowerCase();
    const categories = roleFieldsOf(visual, "category");
    const values = roleFieldsOf(visual, "value");
    const valueLabel = values[0]?.display || visual.fields.find((field) => field.kind !== "column")?.name || visual.typeLabel;
    const categoryLabel = categories[0]?.display || visual.fields[0]?.name || "";
    const color = theme[0] || "#118DFF";

    if (type.includes("textbox") || type.includes("text")) {
      const text = visual.textContent || visual.title || "";
      return `<div class="mini-text">${escapeHtml(text)}</div>`;
    }

    if (type.includes("image")) {
      return `<div class="mini-image" aria-hidden="true"></div>`;
    }

    if (type.includes("shape")) {
      // 塗り色はビジュアルボックス自体に適用済み。未指定時のみプレースホルダを描画。
      return visual.style?.fill ? "" : `<div class="mini-shape" aria-hidden="true"></div>`;
    }

    const data = visual.data;

    if (type.includes("card") || type.includes("kpi") || type.includes("gauge") || type.includes("multirowcard")) {
      const valueText = data?.kind === "card" ? data.text : "—";
      const label = (data?.kind === "card" && data.label) || valueLabel;
      return `
        <div>
          <div class="mini-card-value">${escapeHtml(valueText)}</div>
          <div class="mini-card-label">${escapeHtml(label)}</div>
        </div>
      `;
    }

    if (type.includes("line") || type.includes("area")) {
      const path = data?.kind === "category" ? linePath(data.series, data.max) : "M5 52L28 35L48 42L74 18L96 27L116 10";
      return `
        <svg class="mini-line" viewBox="0 0 120 64" preserveAspectRatio="none" aria-hidden="true">
          <path d="M5 58H116" stroke="#ded8ca" stroke-width="1" />
          <path d="${escapeAttribute(path)}" fill="none" stroke="${escapeAttribute(color)}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        ${miniAxis(data?.categoryLabel || categoryLabel, data?.valueLabel || valueLabel)}
      `;
    }

    if (type.includes("pie") || type.includes("donut")) {
      const stops = data?.kind === "category" ? pieGradientFromData(data.series, theme) : pieGradient(theme);
      const inner = type.includes("donut") ? `<span class="mini-pie-hole"></span>` : "";
      const legend = data?.kind === "category" ? pieLegend(data.series, theme, data.format) : "";
      return `
        <div class="mini-pie-wrap">
          <div class="mini-pie" style="background:conic-gradient(${stops})" aria-hidden="true">${inner}</div>
          ${legend}
        </div>
      `;
    }

    if (type.includes("bar") || type.includes("column") || type.includes("histogram") || type.includes("funnel") || type.includes("waterfall")) {
      const horizontal = type.includes("bar") && !type.includes("column");
      if (data?.kind === "category" && data.series.length) {
        return renderDataBars(data, theme, horizontal);
      }
      const heights = [42, 70, 54, 86, 62];
      const bars = heights
        .map((height, index) => `<span style="height:${height}%;background:${escapeAttribute(theme[index % theme.length])}"></span>`)
        .join("");
      return `
        <div class="mini-bars" aria-hidden="true">${bars}</div>
        ${miniAxis(categoryLabel, valueLabel)}
      `;
    }

    if (type.includes("map")) {
      return `
        <div class="mini-map" aria-hidden="true">
          <span style="left: 22%; top: 38%; background:${escapeAttribute(theme[0])}"></span>
          <span style="left: 62%; top: 28%; width: 20px; height: 20px; background:${escapeAttribute(theme[1] || theme[0])}"></span>
          <span style="left: 48%; top: 62%; background:${escapeAttribute(theme[2] || theme[0])}"></span>
        </div>
      `;
    }

    if (type.includes("slicer")) {
      const items = data?.kind === "slicer" && data.items.length ? data.items : ["項目 1", "項目 2", "項目 3"];
      return `
        <div class="mini-slicer">
          <span class="mini-slicer-head">${escapeHtml(categoryLabel || "Slicer")}</span>
          ${items.slice(0, 6).map((item) => `<span><i></i>${escapeHtml(item)}</span>`).join("")}
        </div>
      `;
    }

    // テーブル / マトリックス
    if (type.includes("table") || type.includes("pivot") || type.includes("matrix")) {
      const columns = data?.kind === "table" ? data.columns : [...categories, ...values].map((field) => field.display);
      if (columns.length) {
        const head = columns.slice(0, 5).map((name) => `<th>${escapeHtml(name)}</th>`).join("");
        const rows = data?.kind === "table" && data.rows.length
          ? data.rows.slice(0, 5).map((row) => `<tr>${row.slice(0, 5).map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`).join("")
          : Array.from({ length: 4 }, () => `<tr>${columns.slice(0, 5).map(() => "<td>—</td>").join("")}</tr>`).join("");
        return `<table class="mini-grid"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
      }
    }

    return `
      <div class="mini-table" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="${index < 3 ? "background:#c9c1b2" : ""}"></span>`).join("")}
      </div>
    `;
  }

  function miniAxis(categoryLabel, valueLabel) {
    if (!categoryLabel && !valueLabel) return "";
    return `<div class="mini-axis"><span>${escapeHtml(valueLabel || "")}</span><span>${escapeHtml(categoryLabel || "")}</span></div>`;
  }

  function pieGradient(theme) {
    const slices = [38, 27, 18, 17];
    let acc = 0;
    return slices
      .map((slice, index) => {
        const start = acc;
        acc += slice;
        return `${theme[index % theme.length]} ${start}% ${acc}%`;
      })
      .join(", ");
  }

  function renderDataBars(data, theme, horizontal) {
    const bars = data.series
      .map((point, index) => {
        const ratio = Math.max(0, Math.abs(point.value) / data.max);
        const size = `${(ratio * 100).toFixed(1)}%`;
        const color = escapeAttribute(theme[index % theme.length]);
        const valueText = formatMeasureValue(point.value, data.format);
        if (horizontal) {
          return `
            <div class="hbar-row" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
              <span class="hbar-label">${escapeHtml(point.label)}</span>
              <span class="hbar-track"><span class="hbar-fill" style="width:${size};background:${color}"></span></span>
              <span class="hbar-value">${escapeHtml(valueText)}</span>
            </div>
          `;
        }
        return `
          <div class="vbar" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
            <span class="vbar-value">${escapeHtml(valueText)}</span>
            <span class="vbar-fill" style="height:${size};background:${color}"></span>
            <span class="vbar-label">${escapeHtml(point.label)}</span>
          </div>
        `;
      })
      .join("");
    return `<div class="${horizontal ? "hbars" : "vbars"}">${bars}</div>`;
  }

  function linePath(series, max) {
    if (!series.length) return "M5 58H116";
    const left = 5;
    const right = 116;
    const top = 8;
    const bottom = 58;
    const step = series.length > 1 ? (right - left) / (series.length - 1) : 0;
    return series
      .map((point, index) => {
        const x = left + step * index;
        const ratio = Math.max(0, Math.abs(point.value) / max);
        const y = bottom - ratio * (bottom - top);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join("");
  }

  function pieGradientFromData(series, theme) {
    const total = series.reduce((sum, point) => sum + Math.max(0, point.value), 0) || 1;
    let acc = 0;
    return series
      .map((point, index) => {
        const start = (acc / total) * 100;
        acc += Math.max(0, point.value);
        const end = (acc / total) * 100;
        return `${theme[index % theme.length]} ${start.toFixed(1)}% ${end.toFixed(1)}%`;
      })
      .join(", ");
  }

  function pieLegend(series, theme, format) {
    return `
      <div class="mini-legend">
        ${series
          .slice(0, 6)
          .map(
            (point, index) => `
              <span class="legend-item">
                <i style="background:${escapeAttribute(theme[index % theme.length])}"></i>
                ${escapeHtml(point.label)} <b>${escapeHtml(formatMeasureValue(point.value, format))}</b>
              </span>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderInspector(page) {
    const visual = page.visuals.find((item) => item.id === state.selectedVisualId) || page.visuals[0] || null;
    if (!visual) {
      els.visualInspector.innerHTML = `
        <div class="muted">${escapeHtml(page.displayName)} にはビジュアルがありません。</div>
      `;
      return;
    }

    const roleBlocks = visual.roles?.length
      ? visual.roles
          .map(
            (role) => `
              <div class="role-row">
                <span class="role-name">${escapeHtml(role.role)}</span>
                <div class="chips">
                  ${role.fields
                    .map((field) => `<span class="chip ${escapeAttribute(field.kind)}">${escapeHtml(field.label)}</span>`)
                    .join("")}
                </div>
              </div>
            `,
          )
          .join("")
      : visual.fields.length
        ? `<div class="chips">${visual.fields
            .slice(0, 24)
            .map((field) => `<span class="chip">${escapeHtml(field.kind)}: ${escapeHtml(field.label)}</span>`)
            .join("")}</div>`
        : `<span class="muted">フィールド参照なし</span>`;

    const style = visual.style || {};
    const styleChips = [
      style.title?.text ? `タイトル: ${style.title.text}` : "",
      style.title?.color ? `タイトル色: ${style.title.color}` : "",
      style.background?.color ? `背景: ${style.background.color}` : "",
      style.border?.show ? `枠線: ${style.border.color || "あり"}` : "",
      style.dataColors?.length ? `データ色: ${style.dataColors.length}件` : "",
    ].filter(Boolean);

    els.visualInspector.innerHTML = `
      <div class="inspector-grid">
        <dl class="kv">
          <div><dt>種別</dt><dd>${escapeHtml(visual.typeLabel)}</dd></div>
          <div><dt>ID</dt><dd>${escapeHtml(visual.id)}</dd></div>
          <div><dt>位置</dt><dd>${formatPosition(visual.position)}</dd></div>
          <div><dt>クエリ</dt><dd>${visual.hasQuery ? "あり" : "なし"}</dd></div>
          <div><dt>フィルタ</dt><dd>${visual.filterCount}</dd></div>
        </dl>
        <div>
          <div class="panel-title">データバインド(ロール別)</div>
          <div class="role-list">${roleBlocks}</div>
          ${styleChips.length ? `<div class="panel-title">書式</div><div class="chips">${styleChips.map((text) => `<span class="chip subtle">${escapeHtml(text)}</span>`).join("")}</div>` : ""}
        </div>
      </div>
    `;
  }

  function renderVisualTable() {
    const visuals = state.project?.report.visuals || [];
    if (!visuals.length) {
      els.visualTable.innerHTML = `<div class="empty-table">ビジュアルなし</div>`;
      return;
    }

    els.visualTable.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>ページ</th>
            <th>ビジュアル</th>
            <th>種別</th>
            <th>フィールド</th>
            <th>ファイル</th>
          </tr>
        </thead>
        <tbody>
          ${visuals
            .map(
              (visual) => `
                <tr>
                  <td>${escapeHtml(visual.pageName)}</td>
                  <td>${escapeHtml(visual.title)}<br><span class="muted">${escapeHtml(visual.id)}</span></td>
                  <td>${escapeHtml(visual.typeLabel)}</td>
                  <td>${visual.fields.length ? visual.fields.slice(0, 6).map((field) => escapeHtml(field.label)).join("<br>") : '<span class="muted">なし</span>'}</td>
                  <td><span class="path">${escapeHtml(visual.path)}</span></td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  function renderModelExplorer() {
    const tables = state.project?.semantic.tables || [];
    if (!tables.length) {
      els.modelExplorer.innerHTML = `<div class="empty-table">モデルなし</div>`;
      return;
    }

    els.modelExplorer.innerHTML = tables
      .map((table) => {
        const rows = [
          ...table.measures.slice(0, 7).map((measure) => ({
            name: measure.name,
            kind: "measure",
            meta: measure.formatString || "",
          })),
          ...table.columns.slice(0, 10).map((column) => ({
            name: column.name,
            kind: "column",
            meta: column.dataType || "",
          })),
        ];

        return `
          <article class="model-table">
            <div class="model-head">
              <h3>${escapeHtml(table.name)}</h3>
              <span class="model-count">${table.columns.length} columns / ${table.measures.length} measures</span>
            </div>
            <div class="field-list">
              ${
                rows.length
                  ? rows
                      .map(
                        (row) => `
                          <div class="field-row">
                            <span>${escapeHtml(row.name)}</span>
                            <span class="field-kind">${escapeHtml(row.kind)}${row.meta ? ` · ${escapeHtml(row.meta)}` : ""}</span>
                          </div>
                        `,
                      )
                      .join("")
                  : '<span class="muted">列またはメジャーを検出できませんでした</span>'
              }
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderFileTable() {
    const entries = state.project?.entries || [];
    if (!entries.length) {
      els.fileTable.innerHTML = `<div class="empty-table">ファイルなし</div>`;
      return;
    }

    els.fileTable.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>種別</th>
            <th>パス</th>
            <th>サイズ</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          ${entries
            .map(
              (entry) => `
                <tr>
                  <td>${escapeHtml(entry.type)}</td>
                  <td><span class="path">${escapeHtml(entry.path)}</span></td>
                  <td>${formatBytes(entry.size || entry.text.length)}</td>
                  <td>${entry.jsonError ? `<span class="muted">${escapeHtml(entry.jsonError)}</span>` : entry.json ? "parsed" : "loaded"}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  function renderIssues() {
    const issues = state.project?.issues || [];
    if (!issues.length) {
      els.issueList.innerHTML = `<div class="empty-table">検出事項なし</div>`;
      return;
    }

    els.issueList.innerHTML = issues
      .map(
        (issue) => `
          <div class="issue ${escapeAttribute(issue.level || "info")}">
            <span class="issue-dot" aria-hidden="true"></span>
            <div>
              <div class="issue-title">${escapeHtml(issue.title)}</div>
              <div class="issue-body">${escapeHtml(issue.detail || "")}</div>
            </div>
          </div>
        `,
      )
      .join("");
  }

  function exportSummary() {
    if (!state.project) return;

    const summary = {
      generatedAt: new Date().toISOString(),
      files: state.project.entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        size: entry.size,
        jsonStatus: entry.jsonError ? "error" : entry.json ? "parsed" : "loaded",
      })),
      report: {
        root: state.project.report.root,
        theme: state.project.report.theme,
        pages: state.project.report.pages.map((page) => ({
          id: page.id,
          displayName: page.displayName,
          width: page.width,
          height: page.height,
          background: page.background,
          visuals: page.visuals.map((visual) => ({
            id: visual.id,
            title: visual.title,
            type: visual.type,
            position: visual.position,
            roles: visual.roles,
            fields: visual.fields,
            style: visual.style,
            textContent: visual.textContent,
            data: visual.data,
            path: visual.path,
          })),
        })),
      },
      semantic: {
        root: state.project.semantic.root,
        tables: state.project.semantic.tables.map((table) => ({
          name: table.name,
          columns: table.columns,
          measures: table.measures,
          hierarchies: table.hierarchies,
          partitions: table.partitions,
        })),
      },
      issues: state.project.issues,
    };

    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "pbip-viewer-summary.json";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function getCurrentPage() {
    const pages = state.project?.report.pages || [];
    return pages.find((page) => page.id === state.selectedPageId) || pages[0] || null;
  }

  function makeProjectStatus(project) {
    return `${project.report.pages.length}ページ / ${project.report.visuals.length}ビジュアル / ${project.semantic.tables.length}テーブル`;
  }

  function setStatus(text) {
    els.statusText.textContent = text;
  }

  function firstJsonEnding(jsonByPath, suffix) {
    const lowerSuffix = suffix.toLowerCase();
    for (const [path, json] of jsonByPath.entries()) {
      if (path.toLowerCase().endsWith(lowerSuffix)) return json;
    }
    return null;
  }

  function findJsonPath(jsonByPath, target) {
    for (const [path, json] of jsonByPath.entries()) {
      if (json === target) return path;
    }
    return null;
  }

  function classifyFile(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".pbip")) return "PBIP";
    if (lower.endsWith(".pbir")) return "PBIR";
    if (lower.endsWith(".pbism")) return "PBISM";
    if (lower.endsWith(".bim")) return "BIM";
    if (lower.endsWith(".tmdl")) return "TMDL";
    if (lower.endsWith(".platform")) return "Platform";
    if (lower.endsWith("/page.json")) return "Page";
    if (lower.endsWith("/visual.json")) return "Visual";
    if (lower.endsWith("/report.json")) return "Report";
    if (lower.endsWith(".json")) return "JSON";
    return "Text";
  }

  function isTextPath(path) {
    const lower = path.toLowerCase();
    return (
      lower.endsWith(".pbip") ||
      lower.endsWith(".pbir") ||
      lower.endsWith(".pbism") ||
      lower.endsWith(".bim") ||
      lower.endsWith(".json") ||
      lower.endsWith(".tmdl") ||
      lower.endsWith(".platform") ||
      lower.endsWith(".txt")
    );
  }

  function isJsonPath(path) {
    const lower = path.toLowerCase();
    return (
      lower.endsWith(".pbip") ||
      lower.endsWith(".pbir") ||
      lower.endsWith(".pbism") ||
      lower.endsWith(".bim") ||
      lower.endsWith(".json") ||
      lower.endsWith(".platform")
    );
  }

  function readText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error(`Cannot read ${file.name}`));
      reader.readAsText(file);
    });
  }

  function stripBom(text) {
    return text.replace(/^\uFEFF/, "");
  }

  function normalizePath(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^\.\//, "");
  }

  function dedupeEntries(entries) {
    const map = new Map();
    for (const entry of entries) {
      map.set(normalizePath(entry.path), {
        ...entry,
        path: normalizePath(entry.path),
      });
    }
    return [...map.values()];
  }

  function getTaggedRoot(path, tag) {
    const parts = normalizePath(path).split("/");
    const index = parts.findIndex((part) => part.endsWith(tag));
    return index >= 0 ? parts.slice(0, index + 1).join("/") : null;
  }

  function dirname(path) {
    const parts = normalizePath(path).split("/");
    parts.pop();
    return parts.join("/");
  }

  function basename(path) {
    return normalizePath(path).split("/").filter(Boolean).pop() || "";
  }

  function inferTableNameFromPath(path) {
    const base = basename(path).replace(/\.tmdl$/i, "");
    return base || null;
  }

  function readTmdlDeclaration(line, keyword) {
    const pattern = new RegExp(`^${keyword}\\s+`, "i");
    if (!pattern.test(line)) return null;

    let rest = line.replace(pattern, "").trim();
    if (!rest || rest.startsWith(":")) return null;

    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      let name = "";
      for (let index = 1; index < rest.length; index += 1) {
        const char = rest[index];
        const next = rest[index + 1];
        if (char === quote && next === quote) {
          name += quote;
          index += 1;
          continue;
        }
        if (char === quote) return name;
        name += char;
      }
      return name || null;
    }

    rest = rest.replace(/\s*=.*$/, "").replace(/\s*:.*$/, "");
    const match = rest.match(/^[^\s{]+(?:\s+[^\s{=:#]+)*/);
    return match ? cleanFieldName(match[0]) : null;
  }

  function readAfterEquals(line) {
    const index = line.indexOf("=");
    return index >= 0 ? line.slice(index + 1).trim() : "";
  }

  function mergeNamedItems(target, incoming) {
    const seen = new Set(target.map((item) => item.name));
    for (const item of incoming) {
      if (!item?.name || seen.has(item.name)) continue;
      seen.add(item.name);
      target.push(item);
    }
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function asText(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function typeLabel(type) {
    const map = {
      clusteredColumnChart: "Clustered column chart",
      clusteredBarChart: "Clustered bar chart",
      stackedColumnChart: "Stacked column chart",
      stackedBarChart: "Stacked bar chart",
      lineChart: "Line chart",
      areaChart: "Area chart",
      pieChart: "Pie chart",
      donutChart: "Donut chart",
      cardVisual: "Card",
      tableEx: "Table",
      pivotTable: "Matrix",
      slicer: "Slicer",
      textbox: "Text box",
      shape: "Shape",
      image: "Image",
      azureMap: "Azure map",
    };
    return map[type] || type || "unknown";
  }

  function percent(value, total) {
    return Math.max(0, Math.min(100, (Number(value) / Number(total || 1)) * 100));
  }

  function formatPosition(position) {
    return `${Math.round(position.x)}, ${Math.round(position.y)} / ${Math.round(position.width)} x ${Math.round(position.height)}`;
  }

  function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function countKeyMatches(root, pattern) {
    let count = 0;
    walk(root, (_node, key) => {
      if (pattern.test(String(key))) count += 1;
    });
    return count;
  }

  function walk(root, visitor) {
    const stack = [{ value: root, key: "" }];
    const seen = new WeakSet();
    while (stack.length) {
      const { value, key } = stack.pop();
      visitor(value, key);
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: value[index], key: String(index) });
        }
      } else {
        for (const [childKey, childValue] of Object.entries(value).reverse()) {
          stack.push({ value: childValue, key: childKey });
        }
      }
    }
  }

  function findFirstScalar(root, keys) {
    const normalizedKeys = new Set(keys.map((key) => key.toLowerCase()));
    let found = null;
    walk(root, (node, key) => {
      if (found !== null) return;
      if (!normalizedKeys.has(String(key).toLowerCase())) return;
      if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
        found = node;
      }
    });
    return found;
  }

  function cleanLiteral(value) {
    let text = String(value || "").trim();
    if (text.startsWith("'") && text.endsWith("'")) {
      text = text.slice(1, -1).replace(/''/g, "'");
    }
    if (text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1).replace(/\\"/g, '"');
    }
    return text;
  }

  function parseEmbeddedJson(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;

    const text = stripBom(value).trim();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function cleanFieldName(value) {
    return cleanLiteral(value)
      .replace(/^\[|\]$/g, "")
      .replace(/^`|`$/g, "")
      .trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  globalTarget.PBIPViewerParser = {
    analyzeProject,
    parseTmdl,
  };
})();
