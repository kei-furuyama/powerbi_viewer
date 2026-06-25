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
    const measureUsage = computeMeasureUsage(report, semantic);
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

    if (measureUsage.unused > 0) {
      const names = semantic.tables
        .flatMap((table) => table.measures.filter((measure) => measure.used === false).map((measure) => `${table.name}[${measure.name}]`))
        .slice(0, 12);
      issues.push({
        level: "warning",
        title: `未使用のメジャーが ${measureUsage.unused} 件あります`,
        detail: `${names.join(" / ")}${measureUsage.unused > names.length ? " ..." : ""}`,
      });
    }

    return {
      uploadedAt: new Date().toISOString(),
      entries: normalizedEntries.sort((a, b) => a.path.localeCompare(b.path)),
      pbipFiles,
      report,
      semantic,
      dataModel: { loadedTables: dataModel.loadedTables },
      measureUsage,
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
    const themeFiles = [reportJson?.themeCollection?.customTheme, reportJson?.themeCollection?.baseTheme];
    let foreground = "";
    let background = "";
    for (const [path, json] of jsonByPath.entries()) {
      const lower = path.toLowerCase();
      if (lower.includes("theme") || lower.includes("/registeredresources/") || lower.includes("/staticresources/")) {
        foreground = foreground || normalizeColor(json?.foreground);
        background = background || normalizeColor(json?.background);
      }
    }
    void themeFiles;
    return {
      dataColors,
      foreground: foreground || "#252423",
      background: background || "#FFFFFF",
      isDefault: dataColors === DEFAULT_THEME_COLORS,
    };
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
    const paragraphs = extractTextParagraphs(visualObject, visualRoot);
    const filters = extractVisualFilters(visualRoot, visualObject);
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
      paragraphs,
      filters,
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
      card: extractCardStyle(objects),
      dataColors: extractDataColors(objects),
    };
  }

  function extractCardStyle(objects) {
    const accentProps = firstObjectProps(objects.accentBar);
    const valueProps = firstObjectProps(objects.value) || firstObjectProps(objects.values) || firstObjectProps(objects.dataLabels);
    const labelProps = firstObjectProps(objects.label) || firstObjectProps(objects.categoryLabels);
    return {
      accentColor: readExprColor(accentProps?.color),
      accentShow: Boolean(accentProps) && readExprBool(accentProps?.show) !== false,
      accentPosition: readExprString(accentProps?.position) || "Left",
      accentWidth: readExprNumber(accentProps?.width),
      valueColor: readExprColor(valueProps?.fontColor),
      labelColor: readExprColor(labelProps?.fontColor),
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

  // テキストボックスの段落を、書式付きの行(段落)→ラン構造として抽出
  function extractTextParagraphs(visualObject, visualRoot) {
    const objects = visualObject?.objects || visualRoot?.objects || {};
    const props =
      firstObjectProps(objects.general) || firstObjectProps(objects.text) || firstObjectProps(objects.textBox);
    const paragraphs = props?.paragraphs;
    if (!Array.isArray(paragraphs)) return [];

    return paragraphs
      .map((paragraph) => {
        const align = cssAlignName(
          readExprString(paragraph?.horizontalTextAlignment) || paragraph?.horizontalTextAlignment || "",
        );
        const runs = (paragraph?.textRuns || [])
          .map((run) => {
            const value = typeof run?.value === "string" ? run.value : readExpr(run?.value);
            if (value == null || value === "") return null;
            const ts = run?.textStyle || {};
            return {
              text: String(value),
              color: normalizeColor(ts.color),
              sizePt: parseFontSize(ts.fontSize),
              bold: /bold/i.test(String(ts.fontWeight || "")) || ts.fontWeight === 700,
              italic: /italic/i.test(String(ts.fontStyle || "")),
              font: typeof ts.fontFamily === "string" ? ts.fontFamily : "",
            };
          })
          .filter(Boolean);
        return runs.length ? { align, runs } : null;
      })
      .filter(Boolean);
  }

  // ビジュアルレベルフィルタ(filterConfig.filters)を解析
  function extractVisualFilters(visualRoot, visualObject) {
    const lists = [
      visualRoot?.filterConfig?.filters,
      visualObject?.filterConfig?.filters,
      Array.isArray(visualRoot?.filters) ? visualRoot.filters : null,
    ].filter(Array.isArray);

    const filters = [];
    for (const list of lists) {
      for (const item of list) {
        const conditions = [];
        const where = item?.filter?.Where;
        if (Array.isArray(where)) {
          for (const clause of where) {
            collectFilterConditions(clause?.Condition, false, conditions);
          }
        }
        if (conditions.length) filters.push({ conditions });
      }
    }
    return filters;
  }

  const COMPARISON_OPS = { 0: "=", 1: ">", 2: ">=", 3: "<", 4: "<=" };

  function collectFilterConditions(condition, negate, out) {
    if (!condition || typeof condition !== "object") return;

    if (condition.Not?.Expression) {
      collectFilterConditions(condition.Not.Expression, !negate, out);
      return;
    }
    if (condition.And) {
      collectFilterConditions(condition.And.Left, negate, out);
      collectFilterConditions(condition.And.Right, negate, out);
      return;
    }
    if (condition.In) {
      const column = condition.In.Expressions?.[0]?.Column?.Property;
      const values = (condition.In.Values || [])
        .map((tuple) => parseDaxLiteral(tuple?.[0]?.Literal?.Value))
        .filter((value) => value != null);
      if (column && values.length) out.push({ column, kind: "in", values, negate });
      return;
    }
    if (condition.Comparison) {
      const column = condition.Comparison.Left?.Column?.Property;
      const value = parseDaxLiteral(condition.Comparison.Right?.Literal?.Value);
      const op = COMPARISON_OPS[condition.Comparison.ComparisonKind] || "=";
      if (column && value != null) out.push({ column, kind: "compare", op, value, negate });
    }
  }

  function parseDaxLiteral(raw) {
    if (raw == null) return null;
    let text = cleanLiteral(String(raw)).trim();
    const numeric = text.replace(/[DLMF]$/i, "");
    if (/^-?\d+(\.\d+)?$/.test(numeric)) return Number(numeric);
    return text;
  }

  function parseFontSize(value) {
    if (value == null) return null;
    const number = Number(String(value).replace(/[^\d.]/g, ""));
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function cssAlignName(value) {
    const text = String(value).toLowerCase();
    if (text.includes("right") || text.includes("end")) return "right";
    if (text.includes("center")) return "center";
    return "";
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

      for (const relationship of json.model?.relationships || json.relationships || []) {
        semantic.relationships.push({
          name: relationship.name || "",
          fromTable: relationship.fromTable || "",
          fromColumn: relationship.fromColumn || "",
          toTable: relationship.toTable || "",
          toColumn: relationship.toColumn || "",
          crossFilter: relationship.crossFilteringBehavior || "",
          toCardinality: relationship.toCardinality || "",
          isActive: relationship.isActive !== false,
        });
      }
    }

    semantic.tables = [...tableMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    semantic.relationships = semantic.relationships.filter((relationship) => relationship.fromTable || relationship.fromColumn || relationship.name);
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
        const relationship = { name: relationshipName, path };
        result.relationships.push(relationship);
        currentItem = { type: "relationship", item: relationship };
        continue;
      }

      if (currentItem?.type === "relationship") {
        const relMatch = line.match(/^(fromColumn|toColumn|fromCardinality|toCardinality|crossFilteringBehavior|isActive)\s*:\s*(.+)$/i);
        if (relMatch) {
          const key = relMatch[1];
          const value = relMatch[2].trim();
          if (/^fromColumn$/i.test(key)) Object.assign(currentItem.item, prefixed("from", parseTmdlColumnRef(value)));
          else if (/^toColumn$/i.test(key)) Object.assign(currentItem.item, prefixed("to", parseTmdlColumnRef(value)));
          else if (/^fromCardinality$/i.test(key)) currentItem.item.fromCardinality = value;
          else if (/^toCardinality$/i.test(key)) currentItem.item.toCardinality = value;
          else if (/^crossFilteringBehavior$/i.test(key)) currentItem.item.crossFilter = value;
          else if (/^isActive$/i.test(key)) currentItem.item.isActive = !/false/i.test(value);
          continue;
        }
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

  // === DAX式エンジン(トークナイザ + 再帰下降パーサ + 評価器) =========

  function tokenizeDax(input) {
    const tokens = [];
    const text = String(input);
    const n = text.length;
    const identStart = /[A-Za-z_À-￿]/;
    const identChar = /[A-Za-z0-9_À-￿]/;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { i += 1; continue; }
      if (c === '"') {
        let j = i + 1; let s = "";
        while (j < n) { if (text[j] === '"') { if (text[j + 1] === '"') { s += '"'; j += 2; continue; } j += 1; break; } s += text[j++]; }
        tokens.push({ t: "str", v: s }); i = j; continue;
      }
      if (c === "'") {
        let j = i + 1; let s = "";
        while (j < n) { if (text[j] === "'") { if (text[j + 1] === "'") { s += "'"; j += 2; continue; } j += 1; break; } s += text[j++]; }
        tokens.push({ t: "tbl", v: s }); i = j; continue;
      }
      if (c === "[") {
        let j = i + 1; let s = "";
        while (j < n && text[j] !== "]") s += text[j++];
        tokens.push({ t: "col", v: s }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
        let j = i; while (j < n && /[0-9.]/.test(text[j])) j += 1;
        tokens.push({ t: "num", v: Number(text.slice(i, j)) }); i = j; continue;
      }
      const two = text.slice(i, i + 2);
      if (["<>", "<=", ">=", "&&", "||"].includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
      if ("+-*/(),=<>&".includes(c)) { tokens.push({ t: "op", v: c }); i += 1; continue; }
      if (identStart.test(c)) {
        let j = i; while (j < n && identChar.test(text[j])) j += 1;
        tokens.push({ t: "id", v: text.slice(i, j) }); i = j; continue;
      }
      i += 1;
    }
    return tokens;
  }

  const DAX_PRECEDENCE = {
    "||": 1, "&&": 2,
    "=": 3, "<>": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
    "&": 4, "+": 4, "-": 4,
    "*": 5, "/": 5,
  };

  function parseDax(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const advance = () => tokens[pos++];

    function parseExpr(minPrec = 0) {
      let left = parseUnary();
      while (true) {
        const tok = peek();
        if (!tok || tok.t !== "op") break;
        const prec = DAX_PRECEDENCE[tok.v];
        if (prec == null || prec < minPrec) break;
        advance();
        const right = parseExpr(prec + 1);
        left = { type: "bin", op: tok.v, l: left, r: right };
      }
      return left;
    }

    function parseUnary() {
      const tok = peek();
      if (tok && tok.t === "op" && tok.v === "-") { advance(); return { type: "unary", e: parseUnary() }; }
      if (tok && tok.t === "op" && tok.v === "+") { advance(); return parseUnary(); }
      return parsePrimary();
    }

    function parseArgs() {
      const args = [];
      if (peek() && peek().t === "op" && peek().v === ")") { advance(); return args; }
      while (true) {
        args.push(parseExpr());
        const tok = peek();
        if (tok && tok.t === "op" && tok.v === ",") { advance(); continue; }
        break;
      }
      if (peek() && peek().t === "op" && peek().v === ")") advance();
      return args;
    }

    function parsePrimary() {
      const tok = advance();
      if (!tok) return { type: "num", v: 0 };
      if (tok.t === "num") return { type: "num", v: tok.v };
      if (tok.t === "str") return { type: "str", v: tok.v };
      if (tok.t === "col") return { type: "ref", name: tok.v };
      if (tok.t === "tbl") {
        if (peek() && peek().t === "col") { const col = advance(); return { type: "col", table: tok.v, name: col.v }; }
        return { type: "tableName", name: tok.v };
      }
      if (tok.t === "id") {
        const nx = peek();
        if (nx && nx.t === "op" && nx.v === "(") { advance(); return { type: "call", name: tok.v.toUpperCase(), args: parseArgs() }; }
        if (nx && nx.t === "col") { const col = advance(); return { type: "col", table: tok.v, name: col.v }; }
        return { type: "name", name: tok.v };
      }
      if (tok.t === "op" && tok.v === "(") {
        const expr = parseExpr();
        if (peek() && peek().t === "op" && peek().v === ")") advance();
        return expr;
      }
      return { type: "num", v: 0 };
    }

    return parseExpr();
  }

  function stripVars(expression) {
    let rest = String(expression).trim();
    const vars = [];
    const keywordAt = (text) => {
      let depth = 0; let inStr = false; let strCh = "";
      for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (inStr) { if (c === strCh) inStr = false; continue; }
        if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
        if (c === "(" || c === "[") depth += 1;
        else if (c === ")" || c === "]") depth -= 1;
        if (depth === 0) {
          const ahead = text.slice(i);
          if (/^\bVAR\b/i.test(ahead) && (i === 0 || /\s/.test(text[i - 1]))) return { kw: "VAR", index: i };
          if (/^\bRETURN\b/i.test(ahead) && (i === 0 || /\s/.test(text[i - 1]))) return { kw: "RETURN", index: i };
        }
      }
      return null;
    };

    while (/^VAR\s/i.test(rest)) {
      const m = rest.match(/^VAR\s+([A-Za-z_À-￿][\wÀ-￿]*)\s*=\s*/i);
      if (!m) break;
      const after = rest.slice(m[0].length);
      const next = keywordAt(after);
      const end = next ? next.index : after.length;
      vars.push({ name: m[1], expr: after.slice(0, end).trim() });
      rest = after.slice(end).trim();
    }
    const ret = rest.match(/^RETURN\s+/i);
    if (ret) rest = rest.slice(ret[0].length).trim();
    return { vars, body: rest };
  }

  function evaluateDax(expression, records, table, model) {
    if (!expression) return null;
    try {
      return evaluateMeasureExpression(String(expression), { table, model, rows: records, row: null, vars: {}, stack: new Set() });
    } catch {
      return null;
    }
  }

  function evaluateMeasureExpression(expression, ctx) {
    const { vars, body } = stripVars(expression);
    const scope = { ...ctx.vars };
    const localCtx = { ...ctx, vars: scope };
    for (const variable of vars) {
      scope[variable.name] = evalDaxNode(parseDax(tokenizeDax(variable.expr)), localCtx);
    }
    return evalDaxNode(parseDax(tokenizeDax(body)), localCtx);
  }

  function toNum(value) {
    if (value == null || value === "" || value === false) return 0;
    if (value === true) return 1;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function isBlank(value) {
    return value == null || value === "";
  }

  function evalDaxNode(node, ctx) {
    if (!node) return null;
    switch (node.type) {
      case "num": return node.v;
      case "str": return node.v;
      case "unary": return -toNum(evalDaxNode(node.e, ctx));
      case "col": return ctx.row ? ctx.row[resolveColumn(ctx.table, node.name)] ?? null : null;
      case "ref": return evalDaxRef(node.name, ctx);
      case "name": return evalDaxName(node.name, ctx);
      case "tableName": return null;
      case "bin": return evalDaxBin(node, ctx);
      case "call": return evalDaxCall(node, ctx);
      default: return null;
    }
  }

  function evalDaxRef(name, ctx) {
    if (ctx.vars && name in ctx.vars) return ctx.vars[name];
    if (ctx.table?.measures?.has(name)) {
      const measure = ctx.table.measures.get(name);
      if (ctx.stack.has(name)) return null;
      ctx.stack.add(name);
      const result = evaluateMeasureExpression(measure.expression, { ...ctx, row: null, vars: {} });
      ctx.stack.delete(name);
      return result;
    }
    // 同じテーブルに無ければモデル全体からメジャーを探す(テーブル横断参照)
    if (ctx.model) {
      for (const table of new Set(ctx.model.values())) {
        if (table === ctx.table || !table.measures?.has(name)) continue;
        if (ctx.stack.has(name)) return null;
        ctx.stack.add(name);
        const result = evaluateMeasureExpression(table.measures.get(name).expression, {
          ...ctx,
          table,
          rows: table.records,
          row: null,
          vars: {},
        });
        ctx.stack.delete(name);
        return result;
      }
    }
    if (ctx.row) {
      const column = resolveColumn(ctx.table, name);
      if (column) return ctx.row[column] ?? null;
    }
    return null;
  }

  function evalDaxName(name, ctx) {
    if (ctx.vars && name in ctx.vars) return ctx.vars[name];
    if (/^TRUE$/i.test(name)) return true;
    if (/^FALSE$/i.test(name)) return false;
    if (/^BLANK$/i.test(name)) return null;
    return null;
  }

  function evalDaxBin(node, ctx) {
    const op = node.op;
    if (op === "&&") return truthy(evalDaxNode(node.l, ctx)) && truthy(evalDaxNode(node.r, ctx));
    if (op === "||") return truthy(evalDaxNode(node.l, ctx)) || truthy(evalDaxNode(node.r, ctx));
    const left = evalDaxNode(node.l, ctx);
    const right = evalDaxNode(node.r, ctx);
    switch (op) {
      case "+": return toNum(left) + toNum(right);
      case "-": return toNum(left) - toNum(right);
      case "*": return toNum(left) * toNum(right);
      case "/": return toNum(right) === 0 ? null : toNum(left) / toNum(right);
      case "&": return `${left ?? ""}${right ?? ""}`;
      case "=": return compareValues(left, right) === 0;
      case "<>": return compareValues(left, right) !== 0;
      case ">": return compareValues(left, right) > 0;
      case "<": return compareValues(left, right) < 0;
      case ">=": return compareValues(left, right) >= 0;
      case "<=": return compareValues(left, right) <= 0;
      default: return null;
    }
  }

  function compareValues(a, b) {
    if (typeof a === "number" || typeof b === "number") {
      const na = toNum(a); const nb = toNum(b);
      return na === nb ? 0 : na < nb ? -1 : 1;
    }
    const sa = String(a ?? ""); const sb = String(b ?? "");
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  }

  function truthy(value) {
    if (value === true) return true;
    if (value === false || value == null) return false;
    if (typeof value === "number") return value !== 0;
    if (value === "") return false;
    return true;
  }

  const DAX_AGGREGATIONS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK", "DISTINCTCOUNT", "PRODUCT"]);
  const DAX_ITERATORS = new Set(["SUMX", "AVERAGEX", "MINX", "MAXX", "COUNTX", "COUNTAX", "PRODUCTX"]);

  function resolveTableArg(node, ctx) {
    if (!node) return ctx.rows;
    if (node.type === "call") {
      const name = node.name;
      if (name === "FILTER") {
        const base = resolveTableArg(node.args[0], ctx);
        return base.filter((row) => truthy(evalDaxNode(node.args[1], { ...ctx, row, rows: base })));
      }
      if (name === "ALL" || name === "ALLSELECTED" || name === "VALUES" || name === "DISTINCT") {
        return ctx.table?.records || ctx.rows;
      }
    }
    if (node.type === "name" || node.type === "tableName") {
      if (ctx.model) {
        const target = ctx.model.get(node.name) || ctx.model.get(normalizeName(node.name));
        if (target && target.name !== ctx.table?.name) return target.records;
      }
      return ctx.rows;
    }
    return ctx.rows;
  }

  function aggregateValues(func, values) {
    const present = values.filter((value) => !isBlank(value));
    const numbers = present.map(toNum);
    switch (func) {
      case "COUNT": return present.filter((value) => Number.isFinite(Number(value))).length;
      case "COUNTA": return present.length;
      case "COUNTBLANK": return values.length - present.length;
      case "DISTINCTCOUNT": return new Set(present.map((value) => String(value))).size;
      case "AVERAGE": return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
      case "MIN": return numbers.length ? Math.min(...numbers) : null;
      case "MAX": return numbers.length ? Math.max(...numbers) : null;
      case "PRODUCT": return numbers.reduce((a, b) => a * b, 1);
      default: return numbers.reduce((a, b) => a + b, 0);
    }
  }

  function evalDaxCall(node, ctx) {
    const name = node.name;
    const args = node.args || [];

    if (name === "CALCULATE") {
      let rows = ctx.rows;
      for (const filter of args.slice(1)) rows = applyCalcFilter(rows, filter, ctx);
      return evalDaxNode(args[0], { ...ctx, rows, row: null });
    }

    if (name === "COUNTROWS") {
      const rows = args.length ? resolveTableArg(args[0], ctx) : ctx.rows;
      return rows.length;
    }

    // MIN/MAX は2引数のスカラー形(行コンテキスト不問)を集計形より優先
    if ((name === "MIN" || name === "MAX") && args.length === 2) {
      const a = toNum(evalDaxNode(args[0], ctx));
      const b = toNum(evalDaxNode(args[1], ctx));
      return name === "MIN" ? Math.min(a, b) : Math.max(a, b);
    }

    if (DAX_AGGREGATIONS.has(name)) {
      const values = ctx.rows.map((row) => evalDaxNode(args[0], { ...ctx, row }));
      return aggregateValues(name, values);
    }

    if (DAX_ITERATORS.has(name)) {
      const rows = resolveTableArg(args[0], ctx);
      const values = rows.map((row) => evalDaxNode(args[1], { ...ctx, row, rows }));
      const base = name.replace(/X$/, "");
      return aggregateValues(base === "COUNTA" ? "COUNTA" : base, values);
    }

    if (name === "DIVIDE") {
      const num = toNum(evalDaxNode(args[0], ctx));
      const den = toNum(evalDaxNode(args[1], ctx));
      if (den === 0) return args[2] ? evalDaxNode(args[2], ctx) : null;
      return num / den;
    }

    if (name === "FORMAT") {
      const value = evalDaxNode(args[0], ctx);
      if (value == null) return "";
      const pattern = evalDaxNode(args[1], ctx);
      const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
      if (Number.isFinite(numeric) && String(value).trim() !== "") {
        return formatMeasureValue(numeric, String(pattern || ""));
      }
      return String(value);
    }

    if (name === "IF") {
      return truthy(evalDaxNode(args[0], ctx)) ? evalDaxNode(args[1], ctx) : (args[2] ? evalDaxNode(args[2], ctx) : null);
    }

    if (name === "IFERROR") {
      const value = evalDaxNode(args[0], ctx);
      return value == null ? evalDaxNode(args[1], ctx) : value;
    }

    if (name === "COALESCE") {
      for (const arg of args) { const value = evalDaxNode(arg, ctx); if (!isBlank(value)) return value; }
      return null;
    }

    if (name === "BLANK") return null;
    if (name === "TRUE") return true;
    if (name === "FALSE") return false;

    if (name === "ABS") return Math.abs(toNum(evalDaxNode(args[0], ctx)));
    if (name === "INT") return Math.trunc(toNum(evalDaxNode(args[0], ctx)));
    if (name === "ROUND") return roundHalf(toNum(evalDaxNode(args[0], ctx)), toNum(evalDaxNode(args[1], ctx)));
    if (name === "ROUNDUP") { const f = 10 ** toNum(evalDaxNode(args[1], ctx)); return Math.ceil(toNum(evalDaxNode(args[0], ctx)) * f) / f; }
    if (name === "ROUNDDOWN") { const f = 10 ** toNum(evalDaxNode(args[1], ctx)); return Math.floor(toNum(evalDaxNode(args[0], ctx)) * f) / f; }

    return null;
  }

  function roundHalf(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function applyCalcFilter(rows, node, ctx) {
    if (node.type === "call" && (node.name === "FILTER" || node.name === "ALL" || node.name === "VALUES" || node.name === "DISTINCT" || node.name === "ALLSELECTED")) {
      return resolveTableArg(node, { ...ctx, rows });
    }
    // ブール述語(列 = 値 など)を行フィルタとして適用
    return rows.filter((row) => truthy(evalDaxNode(node, { ...ctx, row, rows })));
  }

  function formatMeasureValue(value, formatString) {
    if (value == null) return "—";
    // 文字列を返すメジャー(FORMAT連結など)はそのまま表示
    if (typeof value === "string" && !/^-?[\d,]+(\.\d+)?$/.test(value.trim())) return value;
    if (!Number.isFinite(Number(value))) return "—";
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

  function computeMeasureUsage(report, semantic) {
    const used = new Set();
    const mark = (table, name) => {
      if (!name) return;
      used.add(normalizeName(name));
      if (table) used.add(`${normalizeName(table)}|${normalizeName(name)}`);
    };

    // ビジュアルのロール/フィールドから参照を収集
    for (const visual of report.visuals) {
      for (const role of visual.roles || []) {
        for (const field of role.fields) {
          if (field.kind === "measure" || field.kind === "aggregation") mark(field.table, field.name);
        }
      }
      for (const field of visual.fields || []) {
        if (field.kind === "measure") mark(field.table, field.name);
      }
    }

    const allNames = new Set();
    for (const table of semantic.tables) {
      for (const measure of table.measures) allNames.add(measure.name);
    }

    // 他メジャーのDAXから参照されるメジャーも「使用中」とみなす
    for (const table of semantic.tables) {
      for (const measure of table.measures) {
        const refs = String(measure.expression || "").match(/\[([^\]]+)\]/g) || [];
        for (const ref of refs) {
          const name = ref.slice(1, -1);
          if (name !== measure.name && allNames.has(name)) mark(null, name);
        }
      }
    }

    let unused = 0;
    for (const table of semantic.tables) {
      for (const measure of table.measures) {
        const isUsed = used.has(`${normalizeName(table.name)}|${normalizeName(measure.name)}`) || used.has(normalizeName(measure.name));
        measure.used = isUsed;
        if (!isUsed) unused += 1;
      }
    }
    return { unused };
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

  function applyVisualFilters(records, filters, table) {
    if (!filters?.length) return records;
    return records.filter((record) =>
      filters.every((filter) => filter.conditions.every((condition) => matchFilterCondition(record, condition, table))),
    );
  }

  function matchFilterCondition(record, condition, table) {
    const column = resolveColumn(table, condition.column);
    const cell = column ? record[column] : undefined;
    let hit;
    if (condition.kind === "in") {
      hit = condition.values.some((value) => looseEqual(cell, value));
    } else {
      const cmp = compareValues(cell, condition.value);
      switch (condition.op) {
        case ">": hit = cmp > 0; break;
        case "<": hit = cmp < 0; break;
        case ">=": hit = cmp >= 0; break;
        case "<=": hit = cmp <= 0; break;
        default: hit = cmp === 0;
      }
    }
    return condition.negate ? !hit : hit;
  }

  function looseEqual(cell, value) {
    if (typeof value === "number") return Number(cell) === value;
    return String(cell ?? "") === String(value);
  }

  function evaluateField(field, records, table, model) {
    if (!field) return null;
    if (field.kind === "measure") {
      const measure = table.measures.get(field.name);
      if (measure) return { value: evaluateDax(measure.expression, records, table, model), format: measure.formatString };
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
    const model = dataModel.byName;

    // ビジュアルレベルフィルタを filter context として適用
    const records = applyVisualFilters(table.records, visual.filters, table);

    const valueField = values[0];
    const categoryField = categories[0];
    const categoryColumn = categoryField ? resolveColumn(table, categoryField.name) : null;

    // テーブル / マトリックス
    if (type.includes("table") || type.includes("pivot") || type.includes("matrix")) {
      const columnFields = [...categories, ...values.filter((field) => field.kind !== "measure"), ...values.filter((field) => field.kind === "measure")];
      const plain = columnFields.filter((field) => field.kind !== "measure");
      const columnNames = plain.map((field) => resolveColumn(table, field.name) || field.name);
      const rows = records.slice(0, 8).map((record) => columnNames.map((name) => formatCell(record[name])));
      return { kind: "table", columns: plain.map((field) => field.display), rows, total: records.length };
    }

    // スライサー
    if (type.includes("slicer")) {
      const items = [];
      const seen = new Set();
      for (const record of records) {
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
      const evaluated = valueField ? evaluateField(valueField, records, table, model) : null;
      if (!evaluated) return null;
      return { kind: "card", value: evaluated.value, text: formatMeasureValue(evaluated.value, evaluated.format), label: valueField.display };
    }

    // カテゴリ系チャート
    if (categoryColumn && valueField) {
      const groups = new Map();
      for (const record of records) {
        const label = String(record[categoryColumn] ?? "").trim() || "(空白)";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(record);
      }
      let series = [...groups.entries()].map(([label, records]) => {
        const evaluated = evaluateField(valueField, records, table, model);
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
    els.reportCanvas.style.color = state.project?.report?.theme?.foreground || "";

    const theme = getTheme();

    for (const visual of page.visuals) {
      const style = visual.style || {};
      const box = document.createElement("button");
      box.type = "button";
      const lowerType = visual.type.toLowerCase();
      const textLike = lowerType.includes("text") || lowerType.includes("shape");
      box.className = `visual-box ${textLike ? "text-visual" : ""} ${visual.id === state.selectedVisualId ? "selected" : ""}`;
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

      // カードのアクセントバー(Power BIの左帯)を再現
      const card = style.card;
      let accentHtml = "";
      if (card?.accentShow && card.accentColor) {
        const width = Number.isFinite(card.accentWidth) ? Math.min(8, Math.max(2, card.accentWidth)) : 4;
        const sideStyle = /right/i.test(card.accentPosition) ? `right:0` : `left:0`;
        accentHtml = `<span class="card-accent" style="${sideStyle};width:${width}px;background:${escapeAttribute(card.accentColor)}"></span>`;
      }

      box.title = `${visual.typeLabel} / ${visual.fields.length} fields`;
      box.innerHTML = `
        ${accentHtml}
        ${showTitle ? `<div class="visual-title" style="${titleStyle}">${escapeHtml(visual.title)}</div>` : ""}
        <div class="visual-body">${renderVisualPreview(visual, theme, page.height)}</div>
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

  function renderVisualPreview(visual, theme = DEFAULT_THEME_COLORS, pageHeight = DEFAULT_PAGE.height) {
    const type = visual.type.toLowerCase();
    const categories = roleFieldsOf(visual, "category");
    const values = roleFieldsOf(visual, "value");
    const valueLabel = values[0]?.display || visual.fields.find((field) => field.kind !== "column")?.name || visual.typeLabel;
    const categoryLabel = categories[0]?.display || visual.fields[0]?.name || "";
    const color = theme[0] || "#118DFF";

    if (type.includes("textbox") || type.includes("text")) {
      return renderTextbox(visual, pageHeight);
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
      const card = visual.style?.card || {};
      const valueStyle = card.valueColor ? `color:${escapeAttribute(card.valueColor)}` : "";
      const labelStyle = card.labelColor ? `color:${escapeAttribute(card.labelColor)}` : "";
      return `
        <div class="mini-card">
          <div class="mini-card-value" style="${valueStyle}">${escapeHtml(valueText)}</div>
          <div class="mini-card-label" style="${labelStyle}">${escapeHtml(label)}</div>
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

  function renderTextbox(visual, pageHeight) {
    const paragraphs = visual.paragraphs || [];
    // フォントサイズはキャンバス高さ基準のコンテナ単位(cqh)へ変換し、ズームに追従させる
    const toCqh = (pt) => ((pt * 96) / 72 / Math.max(1, pageHeight)) * 100;

    if (paragraphs.length) {
      const html = paragraphs
        .map((paragraph) => {
          const runs = paragraph.runs
            .map((run) => {
              const styles = [
                run.color ? `color:${run.color}` : "",
                run.bold ? "font-weight:700" : "",
                run.italic ? "font-style:italic" : "",
                run.sizePt ? `font-size:${toCqh(run.sizePt).toFixed(2)}cqh` : "",
              ].filter(Boolean).join(";");
              return `<span style="${styles}">${escapeHtml(run.text)}</span>`;
            })
            .join("");
          return `<div class="mini-text-line" style="${paragraph.align ? `text-align:${paragraph.align}` : ""}">${runs}</div>`;
        })
        .join("");
      return `<div class="mini-text rich">${html}</div>`;
    }

    const text = visual.textContent || visual.title || "";
    return `<div class="mini-text">${escapeHtml(text)}</div>`;
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

    const totalUnused = tables.reduce(
      (sum, table) => sum + table.measures.filter((measure) => measure.used === false).length,
      0,
    );

    const summary = totalUnused
      ? `<div class="model-summary">未使用のメジャー: <b>${totalUnused}</b> 件（ビジュアル・他メジャーから参照されていません）</div>`
      : `<div class="model-summary">すべてのメジャーがどこかで使用されています</div>`;

    els.modelExplorer.innerHTML = renderRelationships() + summary + tables
      .map((table) => {
        const measureRows = table.measures
          .map((measure) => {
            const unused = measure.used === false;
            const meta = [measure.formatString].filter(Boolean).map(escapeHtml).join(" · ");
            return `
              <div class="measure-row ${unused ? "unused" : ""}">
                <div class="measure-head">
                  <span class="measure-name">${escapeHtml(measure.name)}</span>
                  <span class="measure-tags">
                    ${unused ? `<span class="tag warn">未使用</span>` : ""}
                    ${meta ? `<span class="field-kind">${meta}</span>` : ""}
                  </span>
                </div>
                ${measure.expression ? `<pre class="measure-dax"><code>${escapeHtml(formatDaxDisplay(measure.expression))}</code></pre>` : ""}
              </div>
            `;
          })
          .join("");

        const columnRows = table.columns
          .slice(0, 30)
          .map(
            (column) => `
              <div class="field-row">
                <span>${escapeHtml(column.name)}</span>
                <span class="field-kind">column${column.dataType ? ` · ${escapeHtml(column.dataType)}` : ""}</span>
              </div>
            `,
          )
          .join("");

        const unusedCount = table.measures.filter((measure) => measure.used === false).length;

        return `
          <article class="model-table">
            <div class="model-head">
              <h3>${escapeHtml(table.name)}</h3>
              <span class="model-count">${table.columns.length} columns / ${table.measures.length} measures${unusedCount ? ` · 未使用 ${unusedCount}` : ""}</span>
            </div>
            ${table.measures.length ? `<div class="panel-title">メジャー (DAX)</div><div class="measure-list">${measureRows}</div>` : ""}
            ${table.columns.length ? `<div class="panel-title">列</div><div class="field-list">${columnRows}</div>` : '<span class="muted">列を検出できませんでした</span>'}
          </article>
        `;
      })
      .join("");
  }

  function renderRelationships() {
    const relationships = state.project?.semantic.relationships || [];
    const usable = relationships.filter((relationship) => relationship.fromTable && relationship.toTable);
    if (!usable.length) {
      return relationships.length
        ? `<div class="model-summary rel-summary">リレーション ${relationships.length} 件（列情報なし）</div>`
        : "";
    }

    const cardinalitySymbol = (relationship) => {
      const many = (relationship.toCardinality || "").toLowerCase() === "many";
      return many ? "* — *" : "* — 1";
    };

    const rows = usable
      .map((relationship) => {
        const both = /both/i.test(relationship.crossFilter || "");
        return `
          <div class="rel-row ${relationship.isActive === false ? "inactive" : ""}">
            <span class="rel-end">${escapeHtml(relationship.fromTable)}<b>[${escapeHtml(relationship.fromColumn)}]</b></span>
            <span class="rel-arrow" title="${both ? "双方向" : "単方向"} / ${escapeHtml(cardinalitySymbol(relationship))}">${both ? "↔" : "→"} <small>${escapeHtml(cardinalitySymbol(relationship))}</small></span>
            <span class="rel-end">${escapeHtml(relationship.toTable)}<b>[${escapeHtml(relationship.toColumn)}]</b></span>
            ${relationship.isActive === false ? `<span class="tag">非アクティブ</span>` : ""}
          </div>
        `;
      })
      .join("");

    return `
      <section class="rel-panel">
        <div class="panel-title">リレーション (${usable.length})</div>
        <div class="rel-list">${rows}</div>
      </section>
    `;
  }

  function formatDaxDisplay(expression) {
    // 主要キーワードの前で改行し、読みやすく整形(簡易)
    return String(expression)
      .replace(/\s+/g, " ")
      .replace(/\s*(VAR |RETURN |CALCULATE\(|FILTER\(|SUMX\(|AVERAGEX\()/gi, "\n$1")
      .replace(/,\s*(?![^()]*\))/g, ",\n  ")
      .trim();
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

  function parseTmdlColumnRef(value) {
    // 例: '都道府県別'.都道府県  /  Table.Column  /  'A B'.'C D'
    const text = String(value || "").trim();
    let table = "";
    let rest = text;
    if (text[0] === "'") {
      const end = text.indexOf("'", 1);
      if (end > 0) { table = text.slice(1, end); rest = text.slice(end + 1); }
    } else {
      const dot = text.indexOf(".");
      if (dot >= 0) { table = text.slice(0, dot); rest = text.slice(dot); }
    }
    const column = rest.replace(/^\s*\.\s*/, "").replace(/^'|'$/g, "").trim();
    return { table: cleanFieldName(table), column: cleanFieldName(column) };
  }

  function prefixed(prefix, ref) {
    return { [`${prefix}Table`]: ref.table, [`${prefix}Column`]: ref.column };
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

  function loadEntriesForPreview(entries) {
    const project = analyzeProject(entries, []);
    state.project = project;
    state.selectedPageId = project.report.pages[0]?.id || null;
    state.selectedVisualId = project.report.pages[0]?.visuals[0]?.id || null;
    state.activeTab = project.report.pages.length ? "canvas" : "issues";
    if (typeof document !== "undefined") {
      if (!Object.keys(els).length) bindElements();
      setStatus(makeProjectStatus(project));
      render();
    }
    return project;
  }

  globalTarget.PBIPViewerParser = {
    analyzeProject,
    parseTmdl,
    evaluateDax,
    extractInlineData,
    loadEntriesForPreview,
  };
})();
