(() => {
  const TEXT_LIMIT = 8 * 1024 * 1024;
  const IMAGE_LIMIT = 12 * 1024 * 1024;
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
        // キャンバス表示時は実幅を測ってフォントスケールを再計算
        if (state.activeTab === "canvas") renderCanvas();
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

    // キャンバス幅が変わったらフォントスケールを再計算するため再描画
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.project && state.activeTab === "canvas") renderCanvas();
      }, 150);
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
      // 検査でエラーがあれば検出事項タブを最初に表示
      state.activeTab = project.validation?.errors > 0 || !project.report.pages.length ? "issues" : "canvas";
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

      if (isImagePath(path)) {
        if (file.size > IMAGE_LIMIT) {
          issues.push({ level: "warning", title: "大きすぎる画像をスキップしました", detail: `${path} (${formatBytes(file.size)})` });
          continue;
        }
        entries.push({ path, text: "", dataUrl: await readDataUrl(file), isImage: true, size: file.size, source: file.name });
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

      const size = entry._data?.uncompressedSize || 0;

      if (isImagePath(path)) {
        if (size > IMAGE_LIMIT) {
          issues.push({ level: "warning", title: "zip内の大きすぎる画像をスキップしました", detail: `${path} (${formatBytes(size)})` });
          return;
        }
        tasks.push(
          entry.async("base64").then((base64) => {
            result.push({ path, text: "", dataUrl: `data:${imageMime(path)};base64,${base64}`, isImage: true, size, source: file.name });
          }),
        );
        return;
      }

      if (!isTextPath(path)) {
        return;
      }

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
    resolveImages(report, normalizedEntries, issues);
    const measureUsage = computeMeasureUsage(report, semantic);
    const validation = validateProject(normalizedEntries, report, semantic, jsonByPath);
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

    // PBIP整合性チェックの結果を反映(エラー/警告は先頭に集約サマリを置く)
    issues.push(...validation.problems);
    const checkSummary = validation.errors > 0
      ? { level: "error", title: `PBIP検査: ${validation.errors}件のエラー`, detail: `このままではPower BIで正しく開けない可能性があります（警告${validation.warnings}件）。下の項目を確認してください。` }
      : validation.warnings > 0
        ? { level: "warning", title: `PBIP検査: 警告${validation.warnings}件`, detail: "致命的エラーはありませんが、確認を推奨する項目があります。" }
        : { level: "info", title: "PBIP検査: 問題は見つかりませんでした", detail: "構造・参照ともに整合しています。" };
    issues.unshift(checkSummary);

    return {
      uploadedAt: new Date().toISOString(),
      entries: normalizedEntries.sort((a, b) => a.path.localeCompare(b.path)),
      pbipFiles,
      report,
      semantic,
      dataModel: { loadedTables: dataModel.loadedTables },
      measureUsage,
      validation,
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
      image: extractBackgroundImage(bgProps) || extractBackgroundImage(outProps),
      imageData: null,
    };
  }

  function extractBackgroundImage(props) {
    const img = props?.image?.image || props?.image;
    if (!img || typeof img !== "object") return null;
    const name = resourceItemName(img.name) || readExprString(img.name) || (typeof img.name === "string" ? img.name : "");
    if (!name) return null;
    return { name, scaling: cssObjectFit(readExprString(img.scaling) || img.scaling) };
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
    const imageRef = type.includes("image") ? extractImageRef(visualObject, visualRoot) : null;
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
      imageRef,
      imageData: null,
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

    const legendProps = firstObjectProps(objects.legend);
    const labelsProps = firstObjectProps(objects.labels) || firstObjectProps(objects.dataLabels) || firstObjectProps(objects.detailLabels);

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
      legend: {
        // legendオブジェクトが存在し show:false の時だけ非表示、未指定は既定ON
        show: legendProps ? readExprBool(legendProps.show) !== false : true,
        explicit: Boolean(legendProps),
        position: legendPosition(readExprString(legendProps?.position)),
      },
      dataLabels: {
        show: labelsProps ? readExprBool(labelsProps.show) !== false : null,
      },
      card: extractCardStyle(objects),
      table: extractTableStyle(objects),
      slicer: extractSlicerStyle(objects),
      dataColors: extractDataColors(objects),
      dataPointRule: extractDataPointRule(objects),
    };
  }

  function extractSlicerStyle(objects) {
    const general = firstObjectProps(objects.general);
    const header = firstObjectProps(objects.header);
    const orientationRaw = readExprString(general?.orientation) || String(readExpr(general?.orientation) ?? "");
    return {
      orientation: /horizontal|^2$/i.test(orientationRaw) ? "horizontal" : "vertical",
      headerShow: header ? readExprBool(header?.show) !== false : true,
      headerText: readExprString(header?.text) || "",
    };
  }

  function extractTableStyle(objects) {
    const header = firstObjectProps(objects.columnHeaders);
    const vals = firstObjectProps(objects.values);
    const tot = firstObjectProps(objects.total) || firstObjectProps(objects.subTotals);
    return {
      headerColor: readExprColor(header?.fontColor),
      headerBack: readExprColor(header?.backColor),
      headerBold: readExprBool(header?.bold) === true,
      fontColor: readExprColor(vals?.fontColorPrimary) || readExprColor(vals?.fontColor),
      bandPrimary: readExprColor(vals?.backColorPrimary),
      bandSecondary: readExprColor(vals?.backColorSecondary),
      backRule: parseColorRule(vals?.backColor) || parseColorRule(vals?.backColorRule),
      fontRule: parseColorRule(vals?.fontColor) || parseColorRule(vals?.fontColorRule),
      total: {
        show: tot ? readExprBool(tot?.show) === true : false,
        color: readExprColor(tot?.fontColor),
        back: readExprColor(tot?.backColor),
      },
    };
  }

  function legendPosition(raw) {
    const text = String(raw || "").toLowerCase();
    if (!text) return "";
    if (text.includes("bottom")) return "bottom";
    if (text.includes("top")) return "top";
    if (text.includes("left")) return "left";
    if (text.includes("right")) return "right";
    return "";
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
      valueSize: parseFontSize(readExpr(valueProps?.fontSize)),
      labelSize: parseFontSize(readExpr(labelProps?.fontSize)),
      valueBold: readExprBool(valueProps?.bold) === true,
      valueAlign: cssAlignName(readExprString(valueProps?.horizontalAlignment)),
      labelAlign: cssAlignName(readExprString(labelProps?.horizontalAlignment)),
      labelPosition: /below/i.test(readExprString(labelProps?.position)) ? "below" : "above",
      labelShow: readExprBool(labelProps?.show) !== false,
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

  // 条件付き書式(データ点 fill のグラデ/ルール)
  function extractDataPointRule(objects) {
    const props = firstObjectProps(objects?.dataPoint);
    return parseColorRule(props?.fill) || parseColorRule(props?.defaultColor);
  }

  // fillRule(グラデ)/backColorRule(ルール) を共通記述子に解析
  function parseColorRule(prop) {
    if (!prop || typeof prop !== "object") return null;
    let grad = null;
    let cases = null;
    walk(prop, (node) => {
      if (grad || cases) return;
      if (!node || typeof node !== "object") return;
      if (node.linearGradient2 || node.linearGradient3) grad = node.linearGradient2 || node.linearGradient3;
      else if (Array.isArray(node.cases)) cases = node.cases;
    });

    if (grad) {
      const stop = (s) => {
        if (!s) return null;
        const color = ruleColorValue(s.color);
        if (!color) return null;
        return { color, value: readExprNumber(s.value) };
      };
      const stops = [stop(grad.min), stop(grad.mid), stop(grad.max)].filter(Boolean);
      if (stops.length >= 2) return { kind: "gradient", stops };
    }
    if (cases) {
      const parsed = cases
        .map((entry) => {
          const cmp = entry.Compare || entry.condition?.Compare || entry.compare;
          const color = ruleColorValue(entry.value ?? entry.color);
          if (!color) return null;
          const op = COMPARISON_OPS[cmp?.ComparisonKind] != null ? COMPARISON_OPS[cmp.ComparisonKind] : "=";
          const value = parseDaxLiteral(cmp?.Right?.Literal?.Value ?? cmp?.right);
          return { op, value, color };
        })
        .filter(Boolean);
      if (parsed.length) return { kind: "rule", cases: parsed };
    }
    return null;
  }

  function ruleColorValue(node) {
    if (node == null) return "";
    const direct = normalizeColor(readExpr(node));
    if (direct) return direct;
    return readExprColor(node);
  }

  // 値→色（グラデは線形補間、ルールは条件一致）
  function evaluateColorRule(rule, value, domain) {
    if (!rule || value == null || !Number.isFinite(Number(value))) return "";
    const num = Number(value);
    if (rule.kind === "rule") {
      for (const c of rule.cases) {
        const cmp = compareValues(num, c.value);
        const hit = c.op === ">" ? cmp > 0 : c.op === "<" ? cmp < 0 : c.op === ">=" ? cmp >= 0 : c.op === "<=" ? cmp <= 0 : c.op === "<>" ? cmp !== 0 : cmp === 0;
        if (hit) return c.color;
      }
      return "";
    }
    // gradient: ストップ値が無ければデータ域を使用
    const stops = rule.stops.map((s, i) => ({ color: s.color, value: Number.isFinite(s.value) ? s.value : null }));
    const lo = Number.isFinite(stops[0].value) ? stops[0].value : domain?.min ?? 0;
    const hi = Number.isFinite(stops[stops.length - 1].value) ? stops[stops.length - 1].value : domain?.max ?? 1;
    if (hi === lo) return stops[stops.length - 1].color;
    const t = Math.max(0, Math.min(1, (num - lo) / (hi - lo)));
    if (stops.length >= 3) {
      return t < 0.5 ? interpolateColor(stops[0].color, stops[1].color, t / 0.5) : interpolateColor(stops[1].color, stops[2].color, (t - 0.5) / 0.5);
    }
    return interpolateColor(stops[0].color, stops[stops.length - 1].color, t);
  }

  function interpolateColor(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    if (!ca || !cb) return a || b || "";
    const mix = (x, y) => Math.round(x + (y - x) * t);
    return rgbToHex(mix(ca[0], cb[0]), mix(ca[1], cb[1]), mix(ca[2], cb[2]));
  }

  function hexToRgb(hex) {
    let h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length < 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
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
    if (value == null || value === "") return undefined;
    const number = Number(String(value).replace(/['D]/g, ""));
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

  // 画像ビジュアルの参照(登録リソース名 or 直接URL)とスケーリングを抽出
  function extractImageRef(visualObject, visualRoot) {
    const objects = visualObject?.objects || visualRoot?.objects || {};
    const general = firstObjectProps(objects.general);
    const imageProps = firstObjectProps(objects.image);

    const resourceName =
      resourceItemName(general?.imageUrl) ||
      resourceItemName(imageProps?.imageUrl) ||
      readExprString(general?.imageUrl) ||
      "";
    const url = readExprString(imageProps?.sourceUrl) || readExprString(imageProps?.url) || readExprString(general?.url);
    const scaling = cssObjectFit(
      readExprString(general?.imageScalingType) || readExprString(imageProps?.imageScalingType) || readExprString(general?.scaling),
    );

    if (!resourceName && !url) return null;
    return { name: resourceName, url, scaling };
  }

  function resourceItemName(prop) {
    if (!prop || typeof prop !== "object") return "";
    const expr = prop.expr || prop;
    return expr?.ResourcePackageItem?.ItemName || expr?.ImageValue?.Url || "";
  }

  function cssObjectFit(scaling) {
    const text = String(scaling || "").toLowerCase();
    if (text.includes("fill")) return "cover";
    if (text.includes("fit")) return "contain";
    if (text.includes("stretch") || text.includes("normal")) return "fill";
    return "contain";
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

  // ポイント(pt)を、キャンバス実描画スケールに合わせたピクセルへ変換
  function ptToPx(pt, scale) {
    return `${(pt * (96 / 72) * (scale || 0.583)).toFixed(1)}px`;
  }

  function groupThousands(numericText) {
    const [intPart, decPart] = String(numericText).split(".");
    const sign = intPart.startsWith("-") ? "-" : "";
    const digits = intPart.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}${digits}${decPart != null ? `.${decPart}` : ""}`;
  }

  // --- 画像リソースの解決(登録名/パス → data URL) --------------------

  function resolveImages(report, entries, issues) {
    const index = new Map();
    for (const entry of entries) {
      if (!entry.isImage || !entry.dataUrl) continue;
      const base = basename(entry.path).toLowerCase();
      index.set(base, entry.dataUrl);
      index.set(normalizeName(base), entry.dataUrl);
      index.set(entry.path.toLowerCase(), entry.dataUrl);
    }

    const resolve = (name) => {
      if (!name) return "";
      const base = basename(name).toLowerCase();
      return index.get(base) || index.get(normalizeName(base)) || index.get(name.toLowerCase()) || "";
    };

    let missing = 0;
    for (const visual of report.visuals) {
      if (!visual.imageRef) continue;
      if (visual.imageRef.url && /^https?:\/\//i.test(visual.imageRef.url)) {
        visual.imageData = visual.imageRef.url;
      } else {
        visual.imageData = resolve(visual.imageRef.name);
        if (!visual.imageData && visual.imageRef.name) missing += 1;
      }
    }
    // report.visualsはpage.visualsのコピーなので、page側にも反映
    const dataById = new Map(report.visuals.map((v) => [`${v.pageId}/${v.id}`, v.imageData]));
    for (const page of report.pages) {
      for (const visual of page.visuals) {
        if (visual.imageRef) visual.imageData = dataById.get(`${page.id}/${visual.id}`) || "";
      }
      if (page.background?.image?.name) {
        page.background.imageData = resolve(page.background.image.name);
      }
    }

    if (missing > 0) {
      issues.push({
        level: "warning",
        title: `画像リソースが見つかりません (${missing}件)`,
        detail: "ビジュアルが参照する画像が StaticResources/RegisteredResources に見つかりませんでした。フォルダごと読み込むと解決できます。",
      });
    }
  }

  // --- PBIP整合性チェック(壊れていないかの検査) ----------------------

  function validateProject(entries, report, semantic, jsonByPath) {
    const problems = [];
    const add = (level, title, detail) => problems.push({ level, title, detail, category: "検査" });

    // 1. JSON解析エラー(Power BIで開けない致命的要因)
    for (const entry of entries) {
      if (entry.jsonError) {
        add("error", "JSONが壊れています", `${entry.path}: ${entry.jsonError}（末尾カンマやクォート漏れに注意）`);
      }
    }

    // 2. 必須ファイルの存在
    const lowerPaths = entries.map((entry) => entry.path.toLowerCase());
    const has = (suffix) => lowerPaths.some((path) => path.endsWith(suffix));
    if (report.root) {
      if (!has("/definition.pbir") && !has("definition.pbir")) {
        add("warning", "definition.pbir が見つかりません", "Reportのデータセット参照(definition.pbir)が無いとPower BIで開けないことがあります。");
      }
      const hasPagesContainer = report.pages.length || report.reportJson?.sections;
      if (!hasPagesContainer) {
        add("error", "ページ定義がありません", "definition/pages/*/page.json が見つかりません。");
      }
    }
    const hasSemanticFiles = entries.some((entry) => /\.tmdl$|model\.bim$/i.test(entry.path));
    const hasSemanticRoot = entries.some((entry) => /\.semanticmodel\//i.test(entry.path));
    if (hasSemanticRoot && !hasSemanticFiles) {
      add("warning", "Semantic Model定義が不足", ".SemanticModel フォルダはありますが model.tmdl / model.bim 等が見つかりません。");
    }

    // 3. ページ整合性(pageOrderと実体の不一致・重複)
    const pageIds = report.pages.map((page) => page.id);
    const dupPages = pageIds.filter((id, index) => pageIds.indexOf(id) !== index);
    for (const id of new Set(dupPages)) add("error", "ページ名が重複しています", id);

    const order = Array.isArray(report.pagesJson?.pageOrder) ? report.pagesJson.pageOrder.map(String) : [];
    if (order.length) {
      for (const id of order) {
        if (!pageIds.includes(id)) add("error", "pageOrderが実在しないページを参照", `pages.json の pageOrder に "${id}" がありますが、対応する page.json がありません。`);
      }
      for (const id of pageIds) {
        if (!order.includes(id)) add("warning", "pageOrderに無いページ", `"${id}" は pages.json の pageOrder に含まれていません。`);
      }
    }
    for (const page of report.pages) {
      if (!page.json?.name) add("error", "page.jsonにnameがありません", page.path);
    }

    // 4. ビジュアル整合性
    for (const page of report.pages) {
      const ids = page.visuals.map((visual) => visual.id);
      for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
        add("warning", "ビジュアル名が重複しています", `${page.displayName} / ${id}`);
      }
      for (const visual of page.visuals) {
        if (visual.jsonStatus === "missing") add("error", "visual.jsonを解析できません", visual.path);
        if (visual.type === "unknown") add("warning", "visualTypeが指定されていません", `${page.displayName} / ${visual.id}`);
        if (visual.position?.fallback) add("warning", "positionがありません", `${page.displayName} / ${visual.id}（座標が補完されました）`);
      }
    }

    // 5. フィールド参照の実在チェック(Claude生成で多い「存在しない列/メジャー」参照)
    if (semantic.tables.length) {
      const index = new Map();
      for (const table of semantic.tables) {
        index.set(normalizeName(table.name), {
          name: table.name,
          cols: new Set(table.columns.map((column) => normalizeName(column.name))),
          meas: new Set(table.measures.map((measure) => normalizeName(measure.name))),
        });
      }
      const checked = new Set();
      for (const visual of report.visuals) {
        for (const role of visual.roles || []) {
          for (const field of role.fields) {
            if (!field.table || !field.name) continue;
            const key = `${visual.pageId}/${visual.id}/${field.label}`;
            if (checked.has(key)) continue;
            checked.add(key);
            const table = index.get(normalizeName(field.table));
            if (!table) {
              add("error", "存在しないテーブルを参照", `${visual.title || visual.id}: '${field.table}' はモデルにありません。`);
              continue;
            }
            const nn = normalizeName(field.name);
            const exists = field.kind === "measure" ? table.meas.has(nn) : table.cols.has(nn) || table.meas.has(nn);
            if (!exists) {
              add("error", "存在しない列/メジャーを参照", `${visual.title || visual.id}: ${field.table}[${field.name}] がモデルにありません。`);
            }
          }
        }
      }

      // 6. メジャーDAXの参照チェック
      const allMeasureNames = new Set();
      const allColumnNames = new Set();
      for (const table of semantic.tables) {
        for (const measure of table.measures) allMeasureNames.add(normalizeName(measure.name));
        for (const column of table.columns) allColumnNames.add(normalizeName(column.name));
      }
      for (const table of semantic.tables) {
        for (const measure of table.measures) {
          const refs = String(measure.expression || "").match(/\[([^\]]+)\]/g) || [];
          for (const ref of refs) {
            const nn = normalizeName(ref.slice(1, -1));
            if (nn === normalizeName(measure.name)) continue;
            if (!allMeasureNames.has(nn) && !allColumnNames.has(nn)) {
              add("warning", "メジャーDAXの参照が見つかりません", `${table.name}[${measure.name}] が [${ref.slice(1, -1)}] を参照していますが、モデルに存在しません。`);
            }
          }
        }
      }

      // 7. リレーションの列実在チェック
      for (const rel of semantic.relationships) {
        if (!rel.fromTable && !rel.toTable) continue;
        const from = index.get(normalizeName(rel.fromTable));
        const to = index.get(normalizeName(rel.toTable));
        if (rel.fromTable && !from) add("warning", "リレーションのテーブルが不明", `${rel.name || "relationship"}: ${rel.fromTable}`);
        if (rel.toTable && !to) add("warning", "リレーションのテーブルが不明", `${rel.name || "relationship"}: ${rel.toTable}`);
        if (from && rel.fromColumn && !from.cols.has(normalizeName(rel.fromColumn))) add("warning", "リレーションの列が不明", `${rel.fromTable}[${rel.fromColumn}]`);
        if (to && rel.toColumn && !to.cols.has(normalizeName(rel.toColumn))) add("warning", "リレーションの列が不明", `${rel.toTable}[${rel.toColumn}]`);
      }
    }

    void jsonByPath;
    const errors = problems.filter((problem) => problem.level === "error").length;
    const warnings = problems.filter((problem) => problem.level === "warning").length;
    return { problems, errors, warnings };
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
      const catFields = [...categories, ...values].filter((field) => field.kind !== "measure");
      const measureFields = [...categories, ...values].filter((field) => field.kind === "measure");
      const allFields = [...catFields, ...measureFields];
      const catColumns = catFields.map((field) => resolveColumn(table, field.name) || field.name);

      // 行 = カテゴリ列の組み合わせでグルーピング(メジャーは各行コンテキストで評価)
      const groupMap = new Map();
      const orderedKeys = [];
      for (const record of records) {
        const key = catColumns.length ? catColumns.map((c) => String(record[c] ?? "")).join("") : "__all__";
        if (!groupMap.has(key)) { groupMap.set(key, []); orderedKeys.push(key); }
        groupMap.get(key).push(record);
      }
      const rowGroups = (catColumns.length ? orderedKeys : ["__all__"]).map((k) => groupMap.get(k) || records);
      const ROW_LIMIT = 10;
      const shown = rowGroups.slice(0, ROW_LIMIT);

      const evalCache = (recs) => allFields.map((field) => {
        if (field.kind === "measure") {
          const ev = evaluateField(field, recs, table, model);
          const value = ev ? Number(ev.value) : null;
          return { text: ev ? formatMeasureValue(ev.value, ev.format) : "", raw: Number.isFinite(value) ? value : null };
        }
        const col = resolveColumn(table, field.name) || field.name;
        const cell = recs[0]?.[col];
        const num = cell != null && cell !== "" && Number.isFinite(Number(cell)) ? Number(cell) : null;
        return { text: formatCell(cell), raw: num };
      });

      const cells = shown.map(evalCache);
      const rows = cells.map((r) => r.map((c) => c.text));
      const rawRows = cells.map((r) => r.map((c) => c.raw));

      // 列が数値か(メジャーは数値、カテゴリ列は全数値なら数値)
      const numericCol = allFields.map((field, i) => {
        if (field.kind === "measure") return true;
        const col = catColumns[i];
        return records.some((r) => r[col] != null && r[col] !== "") && records.every((r) => r[col] == null || r[col] === "" || Number.isFinite(Number(r[col])));
      });
      const colDomains = allFields.map((_, i) => (numericCol[i] ? seriesDomain(rawRows.map((r) => r[i])) : null));

      // 合計行: メジャーは全レコードで評価、数値カテゴリ列は合計
      const totals = allFields.map((field, i) => {
        if (field.kind === "measure") {
          const ev = evaluateField(field, records, table, model);
          return ev ? formatMeasureValue(ev.value, ev.format) : "";
        }
        if (numericCol[i]) return groupThousands(roundTo(records.reduce((s, r) => s + (Number(r[catColumns[i]]) || 0), 0), 2));
        return "";
      });

      return {
        kind: "table",
        columns: allFields.map((field) => field.display),
        rows, rawRows, numericCol, colDomains, totals,
        hasNumeric: numericCol.some(Boolean),
        total: rowGroups.length,
        moreRows: Math.max(0, rowGroups.length - shown.length),
        colCount: allFields.length,
      };
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

    // カテゴリ系チャート(複数系列対応)
    if (categoryColumn && valueField) {
      const seriesField = seriesFieldOf(visual, null);
      // 軸カテゴリは系列フィールドを除いた最初のカテゴリ
      const axisField = categories.find((f) => !seriesField || f.label !== seriesField.label) || categoryField;
      const axisColumn = resolveColumn(table, axisField.name) || categoryColumn;
      const seriesColumn = seriesField ? resolveColumn(table, seriesField.name) : null;
      const valueFields = values; // 複数measure = 複数系列

      // カテゴリごとにレコードをまとめる(出現順を維持)
      const groups = new Map();
      for (const record of records) {
        const label = String(record[axisColumn] ?? "").trim() || "(空白)";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(record);
      }
      let categoriesList = [...groups.keys()];

      // 系列の構築: (1) Series列でピボット / (2) 複数measure / (3) 単一
      let seriesList;
      if (seriesColumn) {
        const seriesVals = [];
        const seen = new Set();
        for (const record of records) {
          const sv = String(record[seriesColumn] ?? "").trim() || "(空白)";
          if (!seen.has(sv)) { seen.add(sv); seriesVals.push(sv); }
          if (seriesVals.length >= 8) break;
        }
        seriesList = seriesVals.map((sv) => ({
          name: sv,
          format: "",
          values: categoriesList.map((cl) => {
            const recs = groups.get(cl).filter((r) => (String(r[seriesColumn] ?? "").trim() || "(空白)") === sv);
            return Number(evaluateField(valueField, recs, table, model)?.value) || 0;
          }),
        }));
        seriesList.forEach((s) => { s.format = evaluateField(valueField, [], table, model)?.format || ""; });
      } else if (valueFields.length > 1) {
        seriesList = valueFields.map((vf) => ({
          name: vf.display,
          format: "",
          values: categoriesList.map((cl) => {
            const evaluated = evaluateField(vf, groups.get(cl), table, model);
            return Number(evaluated?.value) || 0;
          }),
        }));
        seriesList.forEach((s, i) => { s.format = evaluateField(valueFields[i], [], table, model)?.format || ""; });
      } else {
        let fmt = "";
        const valuesArr = categoriesList.map((cl) => {
          const evaluated = evaluateField(valueField, groups.get(cl), table, model);
          fmt = evaluated?.format || fmt;
          return Number(evaluated?.value) || 0;
        });
        seriesList = [{ name: valueField.display, format: fmt, values: valuesArr }];
      }

      const isLine = (type.includes("line") || type.includes("area")) && !type.includes("combo");
      const isCombo = type.includes("combo");
      const stacked = /stacked/i.test(type);
      const normalized = /hundredpercent|100/i.test(type);

      // コンボ: 各系列を棒/線に分類(Line/Y2ロール → 線)
      if (isCombo && !seriesColumn) {
        seriesList.forEach((s, i) => {
          const vf = valueFields[i];
          const role = (visual.roles || []).find((r) => r.fields.includes(vf))?.role || "";
          s.mode = /line|y2/i.test(role) ? "line" : "bar";
        });
        if (!seriesList.some((s) => s.mode === "line") && seriesList.length > 1) {
          seriesList[seriesList.length - 1].mode = "line";
        }
      }

      // 並べ替え(棒/列は合計降順、折れ線は出現順)＋上限
      if (!isLine) {
        const order = categoriesList
          .map((label, index) => ({ index, total: seriesList.reduce((sum, s) => sum + Math.abs(s.values[index]), 0) }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map((entry) => entry.index);
        categoriesList = order.map((i) => categoriesList[i]);
        seriesList = seriesList.map((s) => ({ ...s, values: order.map((i) => s.values[i]) }));
      } else if (categoriesList.length > 24) {
        categoriesList = categoriesList.slice(0, 24);
        seriesList = seriesList.map((s) => ({ ...s, values: s.values.slice(0, 24) }));
      }

      // スケール基準: 集合=単一最大 / 積み上げ=カテゴリ合計の最大 / 100%=1
      let max = 1;
      if (normalized) {
        max = 1;
      } else if (stacked) {
        max = Math.max(1, ...categoriesList.map((_, i) => seriesList.reduce((sum, s) => sum + Math.max(0, s.values[i]), 0)));
      } else {
        max = Math.max(1, ...seriesList.flatMap((s) => s.values.map((v) => Math.abs(v))));
      }

      const format = seriesList[0]?.format || "";
      // 後方互換: 円/ツリーマップ/単一描画用に先頭系列のポイント配列も保持
      const points = categoriesList.map((label, i) => ({ label, value: seriesList[0].values[i], format }));

      const combo = isCombo && seriesList.some((s) => s.mode === "line") && seriesList.some((s) => s.mode !== "line");

      return {
        kind: "category",
        categoryLabel: axisField.display,
        valueLabel: valueField.display,
        categories: categoriesList,
        seriesList,
        multi: seriesList.length > 1,
        stacked,
        normalized,
        combo,
        format,
        max,
        series: points,
      };
    }

    return null;
  }

  // Series/Legendロールのフィールド(カテゴリ用とは別)を取得
  function seriesFieldOf(visual, categoryField) {
    for (const role of visual.roles || []) {
      if (!/^(series|legend|group|details)$/i.test(role.role)) continue;
      const field = role.fields.find((f) => !categoryField || f.label !== categoryField.label);
      if (field) return field;
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
    // ページ背景画像/壁紙
    if (page.background?.imageData) {
      const size = page.background.image?.scaling === "cover" ? "cover" : page.background.image?.scaling === "fill" ? "100% 100%" : "contain";
      els.reportCanvas.style.backgroundImage = `url("${page.background.imageData}")`;
      els.reportCanvas.style.backgroundSize = size;
      els.reportCanvas.style.backgroundPosition = "center";
      els.reportCanvas.style.backgroundRepeat = "no-repeat";
    } else {
      els.reportCanvas.style.backgroundImage = "";
    }

    const theme = getTheme();
    // キャンバスの実描画幅から論理座標→ピクセルのスケールを算出(ズーム追従・全ブラウザ対応)
    const canvasWidthPx = els.reportCanvas.clientWidth || 1120;
    const fontScale = canvasWidthPx / page.width;

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
        style.title?.color ? `color:${escapeAttribute(style.title.color)}` : "",
        style.title?.align ? `text-align:${escapeAttribute(cssAlign(style.title.align))}` : "",
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
        <div class="visual-body">${renderVisualPreview(visual, theme, fontScale)}</div>
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

  function renderVisualPreview(visual, theme = DEFAULT_THEME_COLORS, fontScale = 0.583) {
    const type = visual.type.toLowerCase();
    const categories = roleFieldsOf(visual, "category");
    const values = roleFieldsOf(visual, "value");
    const valueLabel = values[0]?.display || visual.fields.find((field) => field.kind !== "column")?.name || visual.typeLabel;
    const categoryLabel = categories[0]?.display || visual.fields[0]?.name || "";
    const color = theme[0] || "#118DFF";

    if (type.includes("textbox") || type.includes("text")) {
      return renderTextbox(visual, fontScale);
    }

    if (type.includes("image")) {
      if (visual.imageData) {
        const fit = visual.imageRef?.scaling || "contain";
        return `<img class="mini-image-img" src="${escapeAttribute(visual.imageData)}" alt="${escapeHtml(visual.title || "image")}" style="object-fit:${escapeAttribute(fit)}" />`;
      }
      return `<div class="mini-image" aria-hidden="true"></div>`;
    }

    if (type.includes("shape")) {
      // 塗り色はビジュアルボックス自体に適用済み。未指定時のみプレースホルダを描画。
      return visual.style?.fill ? "" : `<div class="mini-shape" aria-hidden="true"></div>`;
    }

    const data = visual.data;

    if (type.includes("treemap")) {
      return renderTreemap(data, theme, categoryLabel, valueLabel);
    }

    if (type.includes("scatter") || type.includes("bubble")) {
      return renderScatter(data, theme);
    }

    if (type.includes("gauge")) {
      const valueText = data?.kind === "card" ? data.text : "—";
      return renderGauge(valueText, valueLabel, color);
    }

    if (type.includes("card") || type.includes("kpi") || type.includes("multirowcard")) {
      const valueText = data?.kind === "card" ? data.text : "—";
      const label = (data?.kind === "card" && data.label) || valueLabel;
      const card = visual.style?.card || {};
      const valueStyle = [
        card.valueColor ? `color:${escapeAttribute(card.valueColor)}` : "",
        card.valueBold ? "font-weight:700" : "",
        card.valueSize ? `font-size:${escapeAttribute(ptToPx(card.valueSize, fontScale))}` : "",
        card.valueAlign ? `text-align:${escapeAttribute(card.valueAlign)}` : "",
      ].filter(Boolean).join(";");
      const labelStyle = [
        card.labelColor ? `color:${escapeAttribute(card.labelColor)}` : "",
        card.labelSize ? `font-size:${escapeAttribute(ptToPx(card.labelSize, fontScale))}` : "",
        card.labelAlign ? `text-align:${escapeAttribute(card.labelAlign)}` : "",
      ].filter(Boolean).join(";");
      const valueHtml = `<div class="mini-card-value" style="${valueStyle}">${escapeHtml(valueText)}</div>`;
      const labelHtml = card.labelShow === false
        ? ""
        : `<div class="mini-card-label" style="${labelStyle}">${escapeHtml(label)}</div>`;
      const body = card.labelPosition === "below" ? `${valueHtml}${labelHtml}` : `${labelHtml}${valueHtml}`;
      return `<div class="mini-card">${body}</div>`;
    }

    if (type.includes("combo") && data?.kind === "category") {
      return wrapWithChartLegend(visual, data, theme, renderCombo(data, theme));
    }

    if ((type.includes("line") || type.includes("area")) && !type.includes("combo")) {
      const isArea = type.includes("area");
      const seriesList = data?.kind === "category" ? data.seriesList : null;
      const paths = seriesList
        ? seriesList.map((s, i) => {
            const stroke = escapeAttribute(theme[i % theme.length]);
            const fill = isArea ? `<path d="${escapeAttribute(areaPath(s.values, data.max))}" fill="${stroke}" fill-opacity="0.18" stroke="none" />` : "";
            return `${fill}<path d="${escapeAttribute(linePath(s.values, data.max))}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
          }).join("")
        : `${isArea ? `<path d="M5 52L28 35L48 42L74 18L96 27L116 10L116 58L5 58Z" fill="${escapeAttribute(color)}" fill-opacity="0.18" stroke="none" />` : ""}<path d="M5 52L28 35L48 42L74 18L96 27L116 10" fill="none" stroke="${escapeAttribute(color)}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />`;
      const svg = `
        <svg class="mini-line" viewBox="0 0 120 64" preserveAspectRatio="none" aria-hidden="true">
          <path d="M5 58H116" stroke="#ded8ca" stroke-width="1" />
          ${paths}
        </svg>
        ${miniAxis(data?.categoryLabel || categoryLabel, data?.valueLabel || valueLabel)}
      `;
      return wrapWithChartLegend(visual, data, theme, svg);
    }

    if (type.includes("pie") || type.includes("donut")) {
      const rule = visual.style?.dataPointRule;
      const sliceColors = data?.kind === "category" ? sliceColorList(data.series, theme, rule) : null;
      const stops = data?.kind === "category" ? pieGradientFromData(data.series, sliceColors) : pieGradient(theme);
      const inner = type.includes("donut") ? `<span class="mini-pie-hole"></span>` : "";
      const legendConf = visual.style?.legend || {};
      const showLegend = legendConf.show !== false && data?.kind === "category";
      const position = legendConf.position || "right";
      const legend = showLegend ? pieLegend(data.series, sliceColors || theme, data.format) : "";
      const pieHtml = `<div class="mini-pie" style="background:conic-gradient(${stops})" aria-hidden="true">${inner}</div>`;
      return `<div class="mini-pie-wrap legend-${escapeAttribute(showLegend ? position : "none")}">${pieHtml}${legend}</div>`;
    }

    if (type.includes("bar") || type.includes("column") || type.includes("histogram") || type.includes("funnel") || type.includes("waterfall") || type.includes("ribbon")) {
      const horizontal = type.includes("bar") && !type.includes("column");
      if (data?.kind === "category" && data.seriesList?.length) {
        const showLabels = visual.style?.dataLabels?.show !== false;
        const chart = data.multi
          ? renderMultiBars(data, theme, horizontal, showLabels)
          : renderDataBars(data, theme, horizontal, showLabels, visual.style?.dataPointRule);
        return wrapWithChartLegend(visual, data, theme, chart);
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
      const sl = visual.style?.slicer || {};
      const items = data?.kind === "slicer" && data.items.length ? data.items : ["項目 1", "項目 2", "項目 3"];
      const horizontal = sl.orientation === "horizontal";
      const head = sl.headerShow === false ? "" : `<span class="mini-slicer-head">${escapeHtml(sl.headerText || categoryLabel || "Slicer")}</span>`;
      const limit = horizontal ? 8 : 6;
      const cells = items.slice(0, limit).map((item) =>
        horizontal ? `<span class="chip-item">${escapeHtml(item)}</span>` : `<span><i></i>${escapeHtml(item)}</span>`,
      ).join("");
      return `<div class="mini-slicer ${horizontal ? "horizontal" : ""}">${head}<div class="mini-slicer-items">${cells}</div></div>`;
    }

    // テーブル / マトリックス
    if (type.includes("table") || type.includes("pivot") || type.includes("matrix")) {
      const columns = data?.kind === "table" ? data.columns : [...categories, ...values].map((field) => field.display);
      if (columns.length) {
        const ts = visual.style?.table || {};
        const maxCols = 7;
        const numericCol = data?.numericCol || [];
        const alignOf = (ci) => (numericCol[ci] ? "text-align:right" : "");
        const headStyle = (ci) => [
          ts.headerColor ? `color:${escapeAttribute(ts.headerColor)}` : "",
          ts.headerBack ? `background:${escapeAttribute(ts.headerBack)}` : "",
          ts.headerBold ? "font-weight:700" : "",
          alignOf(ci),
        ].filter(Boolean).join(";");
        const bodyColor = ts.fontColor ? `color:${escapeAttribute(ts.fontColor)}` : "";
        const head = columns.slice(0, maxCols).map((name, ci) => `<th style="${headStyle(ci)}">${escapeHtml(name)}</th>`).join("");
        const banded = ts.bandPrimary || ts.bandSecondary;
        const cf = ts.backRule || ts.fontRule; // 条件付き書式
        const rows = data?.kind === "table" && data.rows.length
          ? data.rows.map((row, ri) => {
              const band = banded ? `background:${escapeAttribute((ri % 2 ? ts.bandSecondary : ts.bandPrimary) || "")}` : "";
              return `<tr style="${band}">${row.slice(0, maxCols).map((cell, ci) => {
                const style = [bodyColor, alignOf(ci)].filter(Boolean).join(";");
                let cellStyle = style;
                if (cf && numericCol[ci] && data.rawRows?.[ri]?.[ci] != null) {
                  const raw = data.rawRows[ri][ci];
                  const dom = data.colDomains?.[ci];
                  const back = ts.backRule ? evaluateColorRule(ts.backRule, raw, dom) : "";
                  const font = ts.fontRule ? evaluateColorRule(ts.fontRule, raw, dom) : "";
                  cellStyle = [back ? `background:${back}` : "", font ? `color:${font}` : bodyColor, alignOf(ci)].filter(Boolean).join(";");
                }
                return `<td style="${escapeAttribute(cellStyle)}">${escapeHtml(String(cell))}</td>`;
              }).join("")}</tr>`;
            }).join("")
          : Array.from({ length: 4 }, () => `<tr>${columns.slice(0, maxCols).map(() => "<td>—</td>").join("")}</tr>`).join("");
        const totalRow = data?.kind === "table" && ts.total?.show && data.hasNumeric
          ? `<tr class="total-row" style="${[ts.total.color ? `color:${escapeAttribute(ts.total.color)}` : "", ts.total.back ? `background:${escapeAttribute(ts.total.back)}` : ""].filter(Boolean).join(";")}">${data.totals.slice(0, maxCols).map((t, i) => `<td style="${alignOf(i)}">${i === 0 && !t ? "合計" : escapeHtml(String(t))}</td>`).join("")}</tr>`
          : "";
        const moreCols = data?.kind === "table" && data.colCount > maxCols ? data.colCount - maxCols : 0;
        const footParts = [];
        if (data?.moreRows) footParts.push(`他 ${data.moreRows} 行`);
        if (moreCols) footParts.push(`他 ${moreCols} 列`);
        const foot = footParts.length ? `<div class="mini-grid-more">${escapeHtml(footParts.join(" / "))}</div>` : "";
        return `<div class="mini-grid-wrap"><table class="mini-grid"><thead><tr>${head}</tr></thead><tbody>${rows}${totalRow}</tbody></table>${foot}</div>`;
      }
    }

    return `
      <div class="mini-table" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="${index < 3 ? "background:#c9c1b2" : ""}"></span>`).join("")}
      </div>
    `;
  }

  function renderTextbox(visual, fontScale) {
    const paragraphs = visual.paragraphs || [];

    if (paragraphs.length) {
      const html = paragraphs
        .map((paragraph) => {
          const runs = paragraph.runs
            .map((run) => {
              const styles = [
                run.color ? `color:${escapeAttribute(run.color)}` : "",
                run.bold ? "font-weight:700" : "",
                run.italic ? "font-style:italic" : "",
                run.sizePt ? `font-size:${escapeAttribute(ptToPx(run.sizePt, fontScale))}` : "",
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

  function renderDataBars(data, theme, horizontal, showLabels = true, rule = null) {
    const domain = rule ? seriesDomain(data.series.map((p) => p.value)) : null;
    const bars = data.series
      .map((point, index) => {
        const ratio = Math.max(0, Math.abs(point.value) / data.max);
        const size = `${(ratio * 100).toFixed(1)}%`;
        const color = escapeAttribute((rule && evaluateColorRule(rule, point.value, domain)) || theme[index % theme.length]);
        const valueText = formatMeasureValue(point.value, data.format);
        if (horizontal) {
          return `
            <div class="hbar-row" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
              <span class="hbar-label">${escapeHtml(point.label)}</span>
              <span class="hbar-track"><span class="hbar-fill" style="width:${size};background:${color}"></span></span>
              ${showLabels ? `<span class="hbar-value">${escapeHtml(valueText)}</span>` : ""}
            </div>
          `;
        }
        return `
          <div class="vbar" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
            ${showLabels ? `<span class="vbar-value">${escapeHtml(valueText)}</span>` : ""}
            <span class="vbar-fill" style="height:${size};background:${color}"></span>
            <span class="vbar-label">${escapeHtml(point.label)}</span>
          </div>
        `;
      })
      .join("");
    return `<div class="${horizontal ? "hbars" : "vbars"}">${bars}</div>`;
  }

  function renderMultiBars(data, theme, horizontal, showLabels) {
    const { categories, seriesList, stacked, normalized, max, format } = data;
    const stack = stacked || normalized;
    const groups = categories
      .map((label, ci) => {
        const denom = normalized
          ? Math.max(1, seriesList.reduce((sum, ser) => sum + Math.max(0, ser.values[ci]), 0))
          : max;
        const segs = seriesList
          .map((ser, si) => {
            const value = ser.values[ci];
            const pct = Math.max(0, (Math.abs(value) / denom) * 100).toFixed(1);
            const color = escapeAttribute(theme[si % theme.length]);
            const title = escapeAttribute(`${ser.name} · ${label}: ${formatMeasureValue(value, format)}`);
            const dim = horizontal ? `width:${pct}%` : `height:${pct}%`;
            return `<span class="seg" style="${dim};background:${color}" title="${title}"></span>`;
          })
          .join("");
        const labelHtml = `<span class="g-label">${escapeHtml(label)}</span>`;
        const barsHtml = `<span class="bars ${stack ? "stack" : ""}">${segs}</span>`;
        return `<div class="mbar-group">${horizontal ? `${labelHtml}${barsHtml}` : `${barsHtml}${labelHtml}`}</div>`;
      })
      .join("");
    void showLabels;
    return `<div class="mbars ${horizontal ? "h" : "v"}">${groups}</div>`;
  }

  // コンボ(列＋折れ線): 棒系列をバー描画し、線系列をSVGで重ね描き
  function renderCombo(data, theme) {
    const barSeries = data.seriesList.filter((s) => s.mode !== "line");
    const lineSeries = data.seriesList.filter((s) => s.mode === "line");
    const useBars = barSeries.length ? barSeries : data.seriesList;
    const barMax = Math.max(1, ...useBars.flatMap((s) => s.values.map((v) => Math.abs(v))));
    const barData = { ...data, seriesList: useBars, multi: useBars.length > 1, max: barMax };
    const bars = useBars.length > 1 ? renderMultiBars(barData, theme, false, false) : renderDataBars({ ...barData, series: data.categories.map((label, i) => ({ label, value: useBars[0].values[i], format: data.format })) }, theme, false, false);
    const lineMax = Math.max(1, ...lineSeries.flatMap((s) => s.values.map((v) => Math.abs(v))));
    const lines = lineSeries
      .map((s, i) => `<path d="${escapeAttribute(linePath(s.values, lineMax))}" fill="none" stroke="${escapeAttribute(theme[(barSeries.length + i) % theme.length])}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`)
      .join("");
    const overlay = lineSeries.length ? `<svg class="combo-overlay" viewBox="0 0 120 64" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>` : "";
    return `<div class="combo-wrap">${bars}${overlay}</div>`;
  }

  // チャート(棒/折れ線)に系列凡例を付与。legend.show と複数系列のときのみ
  function wrapWithChartLegend(visual, data, theme, chartHtml) {
    if (!data || data.kind !== "category" || !data.multi) return chartHtml;
    const conf = visual.style?.legend || {};
    if (conf.show === false) return `<div class="chart-wrap legend-none"><div class="chart-main">${chartHtml}</div></div>`;
    const position = conf.position || "bottom";
    const items = data.seriesList
      .map((ser, index) => `<span class="legend-item"><i style="background:${escapeAttribute(theme[index % theme.length])}"></i>${escapeHtml(ser.name)}</span>`)
      .join("");
    return `<div class="chart-wrap legend-${escapeAttribute(position)}"><div class="chart-main">${chartHtml}</div><div class="mini-legend chart-legend">${items}</div></div>`;
  }

  function renderTreemap(data, theme, categoryLabel, valueLabel) {
    const series = data?.kind === "category" ? data.series.filter((point) => point.value > 0) : [];
    if (!series.length) {
      return `<div class="mini-treemap" aria-hidden="true">${[40, 26, 18, 16]
        .map((flex, index) => `<span style="flex:${flex};background:${escapeAttribute(theme[index % theme.length])}"></span>`)
        .join("")}</div>`;
    }
    const total = series.reduce((sum, point) => sum + point.value, 0) || 1;
    const tiles = series
      .map((point, index) => {
        const pct = (point.value / total) * 100;
        const valueText = formatMeasureValue(point.value, data.format);
        return `<span class="treemap-tile" style="flex:${point.value};background:${escapeAttribute(theme[index % theme.length])}" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
          <b>${escapeHtml(point.label)}</b><i>${escapeHtml(valueText)}</i>
        </span>`;
      })
      .join("");
    return `<div class="mini-treemap labeled">${tiles}</div>`;
  }

  function renderScatter(data, theme) {
    const series = data?.kind === "category" ? data.series : [];
    const max = data?.max || 1;
    // 値の大小で点の位置・サイズを散らす(擬似配置)
    const dots = (series.length ? series : Array.from({ length: 6 }, (_, i) => ({ value: (i + 1) * (max / 6), label: "" })))
      .slice(0, 16)
      .map((point, index) => {
        const ratio = Math.max(0.05, Math.min(1, Math.abs(point.value) / max));
        const x = 8 + ((index * 37) % 84);
        const y = 88 - ratio * 78;
        const size = 6 + ratio * 8;
        return `<span style="left:${x}%;top:${y.toFixed(0)}%;width:${size.toFixed(0)}px;height:${size.toFixed(0)}px;background:${escapeAttribute(theme[index % theme.length])}" title="${escapeAttribute(point.label || "")}"></span>`;
      })
      .join("");
    return `<div class="mini-scatter" aria-hidden="true">${dots}</div>`;
  }

  function renderGauge(valueText, label, color) {
    return `
      <div class="mini-gauge">
        <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <path d="M6 50 A44 44 0 0 1 94 50" fill="none" stroke="#e7e2d8" stroke-width="10" stroke-linecap="round" />
          <path d="M6 50 A44 44 0 0 1 72 14" fill="none" stroke="${escapeAttribute(color)}" stroke-width="10" stroke-linecap="round" />
        </svg>
        <div class="mini-gauge-value">${escapeHtml(valueText)}</div>
        <div class="mini-card-label">${escapeHtml(label)}</div>
      </div>
    `;
  }

  function linePath(values, max) {
    if (!values.length) return "M5 58H116";
    const left = 5;
    const right = 116;
    const top = 8;
    const bottom = 58;
    const step = values.length > 1 ? (right - left) / (values.length - 1) : 0;
    return values
      .map((raw, index) => {
        const value = typeof raw === "object" && raw ? raw.value : raw; // 数値配列/ポイント配列の両対応
        const x = left + step * index;
        const ratio = Math.max(0, Math.abs(Number(value) || 0) / (max || 1));
        const y = bottom - ratio * (bottom - top);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join("");
  }

  function areaPath(values, max) {
    if (!values.length) return "";
    return `${linePath(values, max)}L116 58L5 58Z`;
  }

  function seriesDomain(values) {
    const nums = values.map(Number).filter((v) => Number.isFinite(v));
    if (!nums.length) return { min: 0, max: 1 };
    return { min: Math.min(...nums), max: Math.max(...nums) };
  }

  function sliceColorList(series, theme, rule) {
    const domain = rule ? seriesDomain(series.map((p) => p.value)) : null;
    return series.map((point, index) => (rule && evaluateColorRule(rule, point.value, domain)) || theme[index % theme.length]);
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
    const base = `${project.report.pages.length}ページ / ${project.report.visuals.length}ビジュアル / ${project.semantic.tables.length}テーブル`;
    const v = project.validation;
    if (!v) return base;
    const check = v.errors > 0 ? `検査NG(エラー${v.errors})` : v.warnings > 0 ? `検査△(警告${v.warnings})` : "検査OK";
    return `${base} / ${check}`;
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
    if (isImagePath(lower)) return "Image";
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

  function isImagePath(path) {
    return /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(path);
  }

  function imageMime(path) {
    const ext = (path.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "svg") return "image/svg+xml";
    return `image/${ext || "png"}`;
  }

  function readText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error(`Cannot read ${file.name}`));
      reader.readAsText(file);
    });
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error(`Cannot read ${file.name}`));
      reader.readAsDataURL(file);
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
