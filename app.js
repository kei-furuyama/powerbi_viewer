(() => {
  const TEXT_LIMIT = 8 * 1024 * 1024;
  const IMAGE_LIMIT = 12 * 1024 * 1024;
  const DEFAULT_PAGE = { width: 1280, height: 720 };
  const state = {
    project: null,
    activeTab: "canvas",
    selectedPageId: null,
    selectedVisualId: null,
    crossFilter: null, // { table, column, value, visualId } — クロスフィルタ選択
    modelUnusedOnly: false, // モデルタブ: 未使用のみ表示
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
      state.crossFilter = null; // クロスフィルタはページ単位
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
      // webkitGetAsEntry はドロップイベント中に同期で取得する必要がある
      const dt = event.dataTransfer;
      const items = dt.items ? [...dt.items] : [];
      const roots = items
        .map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
      const fallback = [...dt.files];
      if (!roots.length || !roots.some((entry) => entry.isDirectory)) {
        handleFiles(fallback);
        return;
      }
      collectDroppedEntries(roots).then((collected) => handleFiles(collected.length ? collected : fallback));
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

  // ドロップされたディレクトリエントリを再帰的に走査して {file, relPath} を集める
  function collectDroppedEntries(roots) {
    const out = [];
    const walkEntry = (entry) => new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (file) => { out.push({ file, relPath: entry.fullPath.replace(/^\/+/, "") }); resolve(); },
          () => resolve(),
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries(
          async (batch) => {
            if (!batch.length) { resolve(); return; }
            await Promise.all(batch.map(walkEntry));
            readBatch(); // readEntries はチャンク返却なので空になるまで繰り返す
          },
          () => resolve(),
        );
        readBatch();
      } else {
        resolve();
      }
    });
    return Promise.all(roots.map(walkEntry)).then(() => out);
  }

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length) {
      setStatus("読み込めるファイルがありませんでした（フォルダは「フォルダを開く」推奨、または .zip をドロップ）");
      return;
    }

    setStatus(`${files.length}件の入力を読み込み中...`);

    try {
      const { entries, issues } = await readUploads(files);
      const project = analyzeProject(entries, issues);
      state.project = project;
      state.crossFilter = null; // 新しいプロジェクトでは選択をリセット
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

    for (const raw of files) {
      const file = raw instanceof File ? raw : raw.file;
      const path = normalizePath((raw && raw.relPath) || file.webkitRelativePath || file.name);
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
      // macOSのzipサイドカーは無視
      if (/(^|\/)__MACOSX\//.test(path) || /(^|\/)\._/.test(path) || /(^|\/)\.DS_Store$/i.test(path)) return;

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

  // ===================================================================
  // 解析パイプライン: entries → report/semantic/dataModel/検査/静的解析
  // (完全にDOM非依存。CLI/MCPもこの関数を import して使う)
  // ===================================================================
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
        // 検査(validateProject)が entry.jsonError から一度だけ報告するので、ここでは二重計上しない
      }
    }

    const report = buildReport(normalizedEntries, jsonByPath);
    const semantic = buildSemantic(normalizedEntries, jsonByPath);
    const dataModel = buildDataModel(semantic);
    hydrateVisualData(report, dataModel);
    resolveImages(report, normalizedEntries, issues);
    let measureUsage;
    try {
      measureUsage = computeModelAnalysis(report, semantic);
    } catch (error) {
      // モデル静的解析が想定外データで失敗しても、全体の解析は止めない
      measureUsage = { unused: 0, unusedColumns: 0, cycles: [], lint: [] };
      issues.push({ level: "warning", title: "モデル静的解析を完了できませんでした", detail: String(error?.message || error) });
    }
    let bestPractices = [];
    try {
      bestPractices = computeBestPractices(report, semantic);
    } catch { /* best-effort */ }
    const validation = validateProject(normalizedEntries, report, semantic, jsonByPath);

    // 循環参照はPower BIで開けない致命的エラーなので、整合性検査に統合する(検査の終了コードに反映)
    if (measureUsage.cycles && measureUsage.cycles.length) {
      for (const ring of measureUsage.cycles) {
        validation.problems.push({
          level: "error",
          title: "メジャーの循環参照",
          detail: ring.join(" → ") + " → " + ring[0] + "（Power BIではエラーになります）",
          category: "検査",
        });
      }
      validation.errors = validation.problems.filter((problem) => problem.level === "error").length;
      validation.warnings = validation.problems.filter((problem) => problem.level === "warning").length;
    }
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

    if (measureUsage.lint && measureUsage.lint.length) {
      const shown = measureUsage.lint.slice(0, 10).map((l) => `${l.measure}: ${l.message}`);
      issues.push({
        level: "warning",
        title: `DAXの改善提案が ${measureUsage.lint.length} 件あります`,
        detail: `${shown.join(" / ")}${measureUsage.lint.length > shown.length ? " ..." : ""}`,
      });
    }

    if (measureUsage.unusedColumns > 0) {
      const cols = semantic.tables
        .flatMap((table) => table.columns.filter((column) => column.used === false).map((column) => `${table.name}[${column.name}]`))
        .slice(0, 12);
      issues.push({
        level: "info",
        title: `未使用の列が ${measureUsage.unusedColumns} 件あります`,
        detail: `${cols.join(" / ")}${measureUsage.unusedColumns > cols.length ? " ..." : ""}（ビジュアル・メジャー・リレーションシップから参照されていません）`,
      });
    }

    for (const bp of bestPractices) {
      issues.push({ level: bp.level, title: `ベストプラクティス: ${bp.title}`, detail: bp.detail });
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
      bestPractices,
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
    activePalette = report.theme?.dataColors?.length ? report.theme.dataColors : DEFAULT_THEME_COLORS;

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

  // 解析中のレポートのテーマパレット(ThemeDataColor の ColorId 解決に使う)
  let activePalette = DEFAULT_THEME_COLORS;

  // hexをpercent(-1..1)で明(正)/暗(負)方向にシェード
  function shadeHex(hex, percent) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return normalizeColor(hex);
    const p = Math.max(-1, Math.min(1, Number(percent) || 0));
    const ch = (i) => {
      const c = parseInt(m[1].slice(i, i + 2), 16);
      const v = p >= 0 ? Math.round(c + (255 - c) * p) : Math.round(c * (1 + p));
      return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
    };
    return `#${ch(0)}${ch(2)}${ch(4)}`;
  }

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

  // 軸にもメジャーにもしないロール(ツールチップ等) → category/value プールから除外
  const NONAXIS_ROLE_NAMES = new Set(["tooltips", "tooltip"]);

  function classifyRole(roleName, fieldKind) {
    const lower = String(roleName || "").toLowerCase();
    if (NONAXIS_ROLE_NAMES.has(lower)) return "meta";
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
    if (field.HierarchyLevel) {
      // 階層レベルはレベル名(Level)が実フィールド名。テーブルは入れ子のSourceRefから。
      const hl = field.HierarchyLevel;
      const hierExpr = hl.Expression?.Hierarchy || hl.Hierarchy;
      const src = hierExpr?.Expression || hierExpr;
      const rawTable = src?.SourceRef?.Entity || src?.SourceRef?.Source;
      table = cleanFieldName(aliasMap.get(String(rawTable)) || rawTable || "");
      name = cleanFieldName(hl.Level || "");
    } else if (inner) {
      const resolved = fieldFromExpression(inner, aliasMap);
      table = cleanFieldName(resolved.table || "");
      name = cleanFieldName(resolved.name || "");
      // 別名が未解決(From句なし)なら queryRef の先頭で実テーブル名を補正
      if (!resolved.tableResolved && projection.queryRef) {
        const qp = String(projection.queryRef).split(".");
        if (qp.length >= 2) table = cleanFieldName(qp[0]);
      }
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
    const shadowProps = firstObjectProps(containerObjects.dropShadow) || firstObjectProps(objects.dropShadow);

    const legendProps = firstObjectProps(objects.legend);
    const labelsProps = firstObjectProps(objects.labels) || firstObjectProps(objects.dataLabels) || firstObjectProps(objects.detailLabels);

    const lineProps = firstObjectProps(objects.line) || firstObjectProps(objects.outline);

    return {
      fill: readExprColor(fillProps?.fillColor) || readExprColor(fillProps?.color),
      line: lineProps
        ? {
            color: readExprColor(lineProps.lineColor) || readExprColor(lineProps.color),
            weight: readExprNumber(lineProps.weight) ?? readExprNumber(lineProps.lineWidth),
            show: readExprBool(lineProps.show) !== false,
          }
        : null,
      title: {
        text: isDisplayText(titleText) ? titleText : "",
        color: readExprColor(titleProps?.fontColor),
        align: readExprString(titleProps?.alignment) || readExprString(titleProps?.titleAlignment) || "",
        show: titleShow !== false,
      },
      background: {
        color: readExprColor(bgProps?.color),
        explicit: Boolean(bgProps),
        show: bgProps ? readExprBool(bgProps?.show) !== false : null,
        transparency: readExprNumber(bgProps?.transparency),
      },
      border: {
        color: readExprColor(borderProps?.color),
        show: readExprBool(borderProps?.show) === true,
        width: readExprNumber(borderProps?.weight) ?? readExprNumber(borderProps?.width),
        radius: readExprNumber(borderProps?.radius),
      },
      shadow: shadowProps
        ? {
            show: readExprBool(shadowProps.show) !== false,
            color: readExprColor(shadowProps.color) || "rgba(0,0,0,0.28)",
          }
        : null,
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
    if (stops.length >= 3) {
      // 中央ストップの「値」を変曲点に使う(0.5固定ではない)
      const mid = Number.isFinite(stops[1].value) ? stops[1].value : (lo + hi) / 2;
      if (num <= mid) {
        const d = mid - lo;
        const t = d === 0 ? 0 : Math.max(0, Math.min(1, (num - lo) / d));
        return interpolateColor(stops[0].color, stops[1].color, t);
      }
      const d = hi - mid;
      const t = d === 0 ? 1 : Math.max(0, Math.min(1, (num - mid) / d));
      return interpolateColor(stops[1].color, stops[2].color, t);
    }
    const t = Math.max(0, Math.min(1, (num - lo) / (hi - lo)));
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
    // テーマパレット参照: { ThemeDataColor: { ColorId, Percent } } を解決
    let themeColor = "";
    walk(prop, (node) => {
      if (themeColor || !node || typeof node !== "object") return;
      const tc = node.ThemeDataColor || node.ThemeColor;
      if (!tc) return;
      const id = Number(readExpr(tc.ColorId) ?? tc.ColorId);
      if (!Number.isFinite(id) || !activePalette.length) return;
      let pct = Number(readExpr(tc.Percent) ?? tc.Percent ?? 0);
      if (!Number.isFinite(pct)) pct = 0;
      if (Math.abs(pct) > 1) pct = pct / 100; // %スケール(例:20)を正規化
      const base = activePalette[((id % activePalette.length) + activePalette.length) % activePalette.length];
      themeColor = shadeHex(base, pct);
    });
    if (themeColor) return themeColor;
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

  // Power BIの透明度(0-100)を反映したrgba。0/未指定は元の色のまま
  function colorWithAlpha(hex, transparency) {
    if (!Number.isFinite(transparency) || transparency <= 0) return hex;
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const alpha = Math.max(0, Math.min(1, 1 - transparency / 100));
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
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

  const COMPARISON_OPS = { 0: "=", 1: ">", 2: ">=", 3: "<", 4: "<=", 5: "<>" };

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
      if (node.HierarchyLevel && typeof node.HierarchyLevel === "object") {
        const hl = node.HierarchyLevel;
        const hierExpr = hl.Expression?.Hierarchy || hl.Hierarchy;
        const src = hierExpr?.Expression || hierExpr;
        const rawTable = src?.SourceRef?.Entity || src?.SourceRef?.Source;
        add("hierarchy", aliasMap.get(String(rawTable)) || rawTable, hl.Level, String(key || ""));
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
      // Entity は実テーブル名、Source は別名(aliasMapで解決できれば真)
      tableResolved: Boolean(expressionRoot.SourceRef?.Entity) || aliasMap.has(String(rawTable)),
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

  // ===================================================================
  // セマンティックモデル解析(TMDL / model.bim → tables/columns/measures/
  // relationships/roles/calculationGroups/refreshPolicies)
  // ===================================================================
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
      // インラインデータ(Table.FromRows)は、各 table 宣言ごとのテキスト範囲から抽出して
      // その table に割り当てる(複数テーブル .tmdl で先頭テーブルへ誤割当しない)。
      const declOffsets = [];
      const declRe = /^[\t ]*table\s+/gim;
      let dm;
      while ((dm = declRe.exec(entry.text))) declOffsets.push(dm.index);
      if (declOffsets.length === parsed.tables.length && declOffsets.length > 0) {
        parsed.tables.forEach((table, i) => {
          const slice = entry.text.slice(declOffsets[i], declOffsets[i + 1] ?? entry.text.length);
          const inline = extractInlineData(slice);
          if (inline) table.data = inline;
        });
      } else {
        const inline = extractInlineData(entry.text);
        if (inline && parsed.tables[0]) parsed.tables[0].data = inline;
      }
      if (parsed.tables.length) {
        parsed.tables.forEach(addTable);
      }
      semantic.relationships.push(...parsed.relationships);
    }

    for (const [path, json] of jsonByPath.entries()) {
      if (!path.toLowerCase().endsWith("model.bim")) continue;
      const tables = json.model?.tables || json.tables || [];
      for (const table of tables) {
        // パーティションのMソースから埋め込みデータ(Table.FromRows)を抽出
        let data;
        for (const partition of table.partitions || []) {
          const src = partition.source || {};
          const expr = Array.isArray(src.expression) ? src.expression.join("\n") : (src.expression || src.query || src.m || "");
          if (expr) { const inline = extractInlineData(String(expr)); if (inline) { data = inline; break; } }
        }
        addTable({
          name: table.name,
          path,
          data,
          columns: (table.columns || []).map((column) => ({
            name: column.name,
            dataType: column.dataType || column.type || "",
            sortByColumn: column.sortByColumn || "",
            isHidden: column.isHidden === true,
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
    const extras = extractModelExtras(entries);
    semantic.roles = extras.roles;
    semantic.calculationGroups = extras.calculationGroups;
    semantic.refreshPolicies = extras.refreshPolicies;
    return semantic;
  }

  // RLSロール / 計算グループ / 増分更新ポリシー を TMDL テキストから軽量に抽出
  function extractModelExtras(entries) {
    const roles = [];
    const calculationGroups = [];
    const refreshPolicies = [];
    const dedentLines = (arr) => {
      const nb = arr.filter((l) => l.trim());
      const min = nb.length ? Math.min(...nb.map((l) => (l.match(/^[\t ]*/)[0] || "").length)) : 0;
      return arr.map((l) => l.slice(min)).join("\n").replace(/\s+$/, "").trim();
    };
    for (const entry of entries.filter((e) => e.path.toLowerCase().endsWith(".tmdl"))) {
      const lines = entry.text.split(/\r?\n/);
      let role = null;
      let calcTable = null;
      let lastTableName = inferTableNameFromPath(entry.path) || "";
      let pending = null; // 複数行の式/フィルタを集める { target, key, ownIndent, lines }
      const flush = () => {
        if (pending && pending.lines.length) pending.target[pending.key] = dedentLines(pending.lines);
        pending = null;
      };
      for (const raw of lines) {
        const t = raw.trim();
        const indent = (raw.match(/^[\t ]*/)[0] || "").length;
        if (pending) {
          if (!t) { pending.lines.push(raw); continue; }
          if (indent > pending.ownIndent) { pending.lines.push(raw); continue; }
          flush();
        }
        const roleM = t.match(/^role\s+(.+)$/i);
        if (roleM) { role = { name: cleanLiteral(roleM[1].trim()), permissions: [] }; roles.push(role); continue; }
        if (role) {
          const permM = t.match(/^tablePermission\s+(.+?)\s*=\s*(.*)$/i);
          if (permM) {
            const p = { table: cleanLiteral(permM[1].trim()), filter: permM[2].trim() };
            role.permissions.push(p);
            if (!p.filter) pending = { target: p, key: "filter", ownIndent: indent, lines: [] };
            continue;
          }
        }
        const tableM = t.match(/^table\s+(.+)$/i);
        if (tableM) { calcTable = null; lastTableName = cleanLiteral(tableM[1].trim()); role = role && indent === 0 ? null : role; }
        if (/^calculationGroup\b/i.test(t)) {
          calcTable = { table: lastTableName || "Calculation Group", items: [] };
          calculationGroups.push(calcTable);
          continue;
        }
        if (calcTable) {
          const itemM = t.match(/^calculationItem\s+(.+?)\s*=\s*(.*)$/i);
          if (itemM) {
            const item = { name: cleanLiteral(itemM[1].trim()), expression: itemM[2].trim() };
            calcTable.items.push(item);
            if (!item.expression) pending = { target: item, key: "expression", ownIndent: indent, lines: [] };
            continue;
          }
        }
        if (/^refreshPolicy\b/i.test(t)) {
          refreshPolicies.push({ table: lastTableName || inferTableNameFromPath(entry.path) || "(table)", path: entry.path });
        }
      }
      flush();
    }
    return { roles, calculationGroups, refreshPolicies };
  }

  function emptySemantic() {
    return {
      root: null,
      tables: [],
      relationships: [],
      roles: [],
      calculationGroups: [],
      refreshPolicies: [],
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

    const indentOf = (s) => (s.match(/^[\t ]*/)[0] || "").length;
    // TMDLのプロパティ宣言(複数行メジャー本文の終端目印にも使う)
    const KNOWN_PROP = /^(formatString|displayFolder|description|isHidden|lineageTag|sourceLineageTag|dataType|dataCategory|sortByColumn|summarizeBy|annotation|changedProperty|formatStringDefinition|relatedColumnDetails|kpi|isNameInferred|isDataTypeInferred|sourceColumn|mode|source)\b/i;
    const DECL = /^(table|column|measure|hierarchy|partition|relationship)\s/i;

    const dedentBlock = (lines) => {
      const nonblank = lines.filter((l) => l.trim());
      const min = nonblank.length ? Math.min(...nonblank.map(indentOf)) : 0;
      return lines.map((l) => l.slice(min)).join("\n").replace(/\s+$/, "");
    };

    const rawLines = text.split(/\r?\n/);
    for (let li = 0; li < rawLines.length; li += 1) {
      const rawLine = rawLines[li];
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const indent = indentOf(rawLine);

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
        currentItem = { type: "column", indent, item: { name: columnName, dataType: "", formatString: "" } };
        ensureTable().columns.push(currentItem.item);
        continue;
      }

      const measureName = readTmdlDeclaration(line, "measure");
      if (measureName) {
        const item = { name: measureName, expression: "", formatString: "" };
        const afterEq = readAfterEquals(line);
        if (afterEq.startsWith("```")) {
          // バッククォート囲みブロック: 閉じ ``` まで取り込む
          const body = [];
          for (li += 1; li < rawLines.length; li += 1) {
            if (rawLines[li].trim() === "```") break;
            body.push(rawLines[li]);
          }
          item.expression = dedentBlock(body).trim();
        } else if (afterEq) {
          item.expression = afterEq;
        } else {
          // 宣言行に式が無い場合、宣言よりも深いインデントの行を本文として収集。
          // KNOWN_PROP/DECL は本文の基準インデント以下のときだけ終端扱い(DAX中の
          // Description/Source 等の識別子で途切れないように)。
          const body = [];
          let lj = li + 1;
          let bodyIndent = null;
          for (; lj < rawLines.length; lj += 1) {
            const rl = rawLines[lj];
            const t = rl.trim();
            if (!t) { body.push(rl); continue; }
            const ind = indentOf(rl);
            if (ind <= indent) break;
            if (bodyIndent === null) bodyIndent = ind;
            if (ind <= bodyIndent && (KNOWN_PROP.test(t) || DECL.test(t))) break;
            body.push(rl);
          }
          while (body.length && !body[body.length - 1].trim()) body.pop();
          item.expression = dedentBlock(body).trim().replace(/^=\s*/, "");
          li = lj - 1;
        }
        currentItem = { type: "measure", indent, item };
        ensureTable().measures.push(item);
        continue;
      }

      const hierarchyName = readTmdlDeclaration(line, "hierarchy");
      if (hierarchyName) {
        currentItem = { type: "hierarchy", indent, item: { name: hierarchyName } };
        ensureTable().hierarchies.push(currentItem.item);
        continue;
      }

      const partitionName = readTmdlDeclaration(line, "partition");
      if (partitionName) {
        currentItem = { type: "partition", indent, item: { name: partitionName } };
        ensureTable().partitions.push(currentItem.item);
        continue;
      }

      const relationshipName = readTmdlDeclaration(line, "relationship");
      if (relationshipName) {
        const relationship = { name: relationshipName, path };
        result.relationships.push(relationship);
        currentItem = { type: "relationship", indent, item: relationship };
        continue;
      }

      // プロパティはカレント項目より深いインデントのときだけ束縛(スコープ外への漏れ防止)
      const childOfCurrent = currentItem && indent > currentItem.indent;

      if (currentItem?.type === "relationship" && childOfCurrent) {
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

      if (childOfCurrent && /^dataType\s*:/i.test(line)) {
        currentItem.item.dataType = line.split(":").slice(1).join(":").trim();
      }

      if (childOfCurrent && /^formatString\s*:/i.test(line)) {
        currentItem.item.formatString = cleanLiteral(line.split(":").slice(1).join(":").trim());
      }

      if (currentItem?.type === "column" && childOfCurrent && /^sortByColumn\s*:/i.test(line)) {
        currentItem.item.sortByColumn = cleanLiteral(line.split(":").slice(1).join(":").trim());
      }

      if (childOfCurrent && /^isHidden\b/i.test(line) && (currentItem.type === "column" || currentItem.type === "measure")) {
        currentItem.item.isHidden = !/:\s*false\b/i.test(line);
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
    // 同じ Table.FromRows 呼び出しの引数内に探索範囲を限定(後続の別呼び出しを拾わない)
    const nextCall = text.indexOf("Table.FromRows", afterRows);
    const searchEnd = nextCall < 0 ? text.length : nextCall;
    // 空白に寛容に "type table" を探す(type  table / type\ntable)
    const typeRe = /type\s+table/g;
    typeRe.lastIndex = afterRows;
    const typeMatch = typeRe.exec(text);
    const typeIdx = typeMatch && typeMatch.index < searchEnd ? typeMatch.index : -1;
    let columns = [];
    if (typeIdx >= 0) {
      const colStart = text.indexOf("[", typeIdx);
      const colBlock = readBalanced(text, colStart, "[", "]");
      if (colBlock) columns = parseTypeTable(colBlock);
    }
    // 列名リスト形式 Table.FromRows(rows, {"列1","列2"}) にも対応(type table が無い場合)
    if (!columns.length) {
      const cm = text.slice(afterRows).match(/^\s*,\s*\{/);
      if (cm) {
        const braceIdx = text.indexOf("{", afterRows);
        const listBlock = readBalanced(text, braceIdx, "{", "}");
        if (listBlock) {
          const names = [...listBlock.matchAll(/"((?:[^"]|"")*)"/g)].map((x) => x[1].replace(/""/g, '"'));
          if (names.length) columns = names.map((n) => ({ name: n, type: "" }));
        }
      }
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
    // リレーションをモデルに添付(DAXの RELATED/RELATEDTABLE/USERELATIONSHIP 用)。
    // Map にプロパティとして持たせるので evaluateDax 既存シグネチャを変えない。
    byName.relationships = (semantic.relationships || [])
      .filter((rel) => rel.fromTable && rel.fromColumn && rel.toTable && rel.toColumn)
      .map((rel) => ({
        fromTable: rel.fromTable,
        fromColumn: rel.fromColumn,
        toTable: rel.toTable,
        toColumn: rel.toColumn,
        isActive: rel.isActive !== false,
        toCardinality: rel.toCardinality || "",
      }));
    return { byName, loadedTables };
  }

  function normalizeName(value) {
    return String(value || "").toLowerCase().replace(/[\s_'"\[\]]+/g, "");
  }

  function resolveColumn(table, name) {
    if (!table) return null;
    // 正規化名→実列名のマップをテーブルに一度だけ構築(行ごとの線形探索を回避)
    if (!table.__colMap) {
      const map = new Map();
      for (const item of table.columns) map.set(normalizeName(item.name), item.name);
      Object.defineProperty(table, "__colMap", { value: map, enumerable: false });
    }
    return table.__colMap.get(normalizeName(name)) || null;
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
      // コメント: // と -- は行末まで、/* */ はブロック
      if ((c === "/" && text[i + 1] === "/") || (c === "-" && text[i + 1] === "-")) {
        i += 2; while (i < n && text[i] !== "\n") i += 1; continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1; i += 2; continue;
      }
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
        // 列名内の ]] はエスケープされた ]
        let j = i + 1; let s = "";
        while (j < n) { if (text[j] === "]") { if (text[j + 1] === "]") { s += "]"; j += 2; continue; } j += 1; break; } s += text[j++]; }
        tokens.push({ t: "col", v: s }); i = j; continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
        // 小数点は1個まで(1.2.3 → 1.2 と .3 に分割)
        let j = i; let seenDot = false;
        while (j < n) { const ch = text[j]; if (ch >= "0" && ch <= "9") { j += 1; continue; } if (ch === "." && !seenDot) { seenDot = true; j += 1; continue; } break; }
        // 指数表記 1e3 / 1.5E-2 に対応
        if ((text[j] === "e" || text[j] === "E") && /[0-9+-]/.test(text[j + 1] || "")) {
          j += 1; if (text[j] === "+" || text[j] === "-") j += 1;
          while (j < n && /[0-9]/.test(text[j])) j += 1;
        }
        const nv = Number(text.slice(i, j));
        tokens.push({ t: "num", v: Number.isNaN(nv) ? 0 : nv }); i = j; continue;
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
    "&": 4,
    "+": 5, "-": 5,
    "*": 6, "/": 6,
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
      return evaluateMeasureExpression(String(expression), {
        table, model, rows: records, row: null, vars: {}, stack: new Set(),
        relationships: model?.relationships || [], activeRel: null,
      });
    } catch {
      return null;
    }
  }

  // コンパイル済みDAX(VAR分解 + トークナイズ + パース)を式文字列でキャッシュ。
  // ASTは評価中に変更しないため再利用可能。メジャーは(カテゴリ×ビジュアル)で多数回評価されるため効く。
  const __daxCache = new Map();
  const DAX_CACHE_LIMIT = 2000;
  function compileDax(expression) {
    let compiled = __daxCache.get(expression);
    if (!compiled) {
      const { vars, body } = stripVars(expression);
      compiled = {
        vars: vars.map((v) => ({ name: v.name, ast: parseDax(tokenizeDax(v.expr)) })),
        bodyAst: parseDax(tokenizeDax(body)),
      };
      // 上限超過時は最古を破棄(無制限な蓄積を防ぐ)
      if (__daxCache.size >= DAX_CACHE_LIMIT) __daxCache.delete(__daxCache.keys().next().value);
      __daxCache.set(expression, compiled);
    }
    return compiled;
  }

  function evaluateMeasureExpression(expression, ctx) {
    const { vars, bodyAst } = compileDax(expression);
    const scope = { ...ctx.vars };
    const localCtx = { ...ctx, vars: scope };
    for (const variable of vars) {
      scope[variable.name] = evalDaxNode(variable.ast, localCtx);
    }
    return evalDaxNode(bodyAst, localCtx);
  }

  function toNum(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : (value.getTime() - DAX_EPOCH) / 86400000;
    if (value == null || value === "" || value === false) return 0;
    if (value === true) return 1;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function isBlank(value) {
    return value == null || value === "";
  }

  // --- DAX 日付サポート(シリアル=1899-12-30からの日数, UTC基準) -----------
  const DAX_EPOCH = Date.UTC(1899, 11, 30);

  function toDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number" && Number.isFinite(value)) return new Date(DAX_EPOCH + value * 86400000);
    if (typeof value === "string") {
      const s = value.trim();
      const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
      if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
      const t = Date.parse(s);
      if (!Number.isNaN(t)) return new Date(t);
    }
    return null;
  }

  function makeUTCDate(y, m, d, hh = 0, mm = 0, ss = 0) {
    return new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  }

  function addMonths(date, months) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + months;
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(y, m, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
  }

  function evalDaxNode(node, ctx) {
    if (!node) return null;
    switch (node.type) {
      case "num": return node.v;
      case "str": return node.v;
      case "unary": return -toNum(evalDaxNode(node.e, ctx));
      case "col": return evalDaxColRef(node, ctx);
      case "ref": return evalDaxRef(node.name, ctx);
      case "name": return evalDaxName(node.name, ctx);
      case "tableName": return null;
      case "bin": return evalDaxBin(node, ctx);
      case "call": return evalDaxCall(node, ctx);
      default: return null;
    }
  }

  // 列参照: 修飾子(node.table)を尊重。別テーブルならリレーションをたどる(RELATED相当)。
  function evalDaxColRef(node, ctx) {
    if (!ctx.row) return null;
    const t = node.table
      ? (ctx.model?.get(node.table) || ctx.model?.get(normalizeName(node.table)) || ctx.table)
      : ctx.table;
    if (!t) return null;
    if (ctx.table && normalizeName(t.name) === normalizeName(ctx.table.name)) {
      return ctx.row[resolveColumn(ctx.table, node.name)] ?? null;
    }
    const related = relatedRow(ctx, t.name);
    if (related) return related[resolveColumn(t, node.name)] ?? null;
    return null;
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
        // 行コンテキストがある場合(反復子内)は、現在行に関連する行だけへ文脈変換(過剰計上防止)
        let measureRows = table.records;
        if (ctx.row && ctx.table) {
          const rel = findRelationship(ctx, ctx.table.name, table.name);
          if (rel) {
            const factIsFrom = normalizeName(rel.fromTable) === normalizeName(ctx.table.name);
            const localCol = resolveColumn(ctx.table, factIsFrom ? rel.fromColumn : rel.toColumn);
            const remoteCol = resolveColumn(table, factIsFrom ? rel.toColumn : rel.fromColumn);
            const localVal = String(ctx.row[localCol] ?? "");
            measureRows = table.records.filter((r) => String(r[remoteCol] ?? "") === localVal);
          } else {
            measureRows = [];
          }
        }
        const result = evaluateMeasureExpression(table.measures.get(name).expression, {
          ...ctx,
          table,
          rows: measureRows,
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
      case "&": return `${daxStr(left)}${daxStr(right)}`;
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
    if (a instanceof Date || b instanceof Date) {
      const ta = toDate(a)?.getTime() ?? NaN;
      const tb = toDate(b)?.getTime() ?? NaN;
      return ta === tb ? 0 : ta < tb ? -1 : 1;
    }
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
    if (value instanceof Date) return true;
    if (typeof value === "number") return value !== 0;
    if (value === "") return false;
    return true;
  }

  const DAX_AGGREGATIONS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK", "DISTINCTCOUNT", "PRODUCT", "MEDIAN", "GEOMEAN"]);
  const DAX_ITERATORS = new Set(["SUMX", "AVERAGEX", "MINX", "MAXX", "COUNTX", "COUNTAX", "PRODUCTX", "MEDIANX", "GEOMEANX"]);

  // 2テーブル間のアクティブなリレーションを探す(USERELATIONSHIP指定があれば優先)
  function findRelationship(ctx, tableA, tableB) {
    const a = normalizeName(tableA);
    const b = normalizeName(tableB);
    const rels = ctx.relationships || [];
    const between = (r) => {
      const f = normalizeName(r.fromTable); const t = normalizeName(r.toTable);
      return (f === a && t === b) || (f === b && t === a);
    };
    if (ctx.activeRel && between(ctx.activeRel)) return ctx.activeRel;
    return rels.find((r) => r.isActive && between(r)) || rels.find(between) || null;
  }

  // USERELATIONSHIP(col1, col2) の2列に一致するリレーションを返す(アクティブ扱い)
  function relationshipForColumns(ctx, c1, c2) {
    if (!c1 || !c2 || c1.type !== "col" || c2.type !== "col") return null;
    const key = (t, col) => `${normalizeName(t)}|${normalizeName(col)}`;
    const a = key(c1.table, c1.name);
    const b = key(c2.table, c2.name);
    for (const rel of ctx.relationships || []) {
      const f = key(rel.fromTable, rel.fromColumn);
      const t = key(rel.toTable, rel.toColumn);
      if ((f === a && t === b) || (f === b && t === a)) return { ...rel, isActive: true };
    }
    return null;
  }

  // 現在行(ctx.row/ctx.table)から対象テーブルへリレーションを辿った一致行を返す
  function relatedRow(ctx, targetName) {
    if (!ctx.row || !ctx.table || !ctx.model) return null;
    const target = ctx.model.get(targetName) || ctx.model.get(normalizeName(targetName));
    if (!target) return null;
    const rel = findRelationship(ctx, ctx.table.name, target.name);
    if (!rel) return null;
    const fromIsHere = normalizeName(rel.fromTable) === normalizeName(ctx.table.name);
    const localCol = fromIsHere ? rel.fromColumn : rel.toColumn;
    const remoteCol = fromIsHere ? rel.toColumn : rel.fromColumn;
    const localVal = ctx.row[resolveColumn(ctx.table, localCol)];
    const remoteKey = resolveColumn(target, remoteCol);
    return target.records.find((r) => compareValues(r[remoteKey], localVal) === 0) || null;
  }

  // タイムインテリジェンス用: 日付列の所属テーブルと列キーを解決
  function resolveDateColumn(ctx, node) {
    let table = null;
    let colName = null;
    if (node?.type === "col") { table = ctx.model?.get(node.table) || ctx.model?.get(normalizeName(node.table)); colName = node.name; }
    else if (node?.type === "ref") { table = ctx.table; colName = node.name; }
    if (!table) table = ctx.table;
    return { table, key: table ? resolveColumn(table, colName) : null };
  }

  // 現在のフィルタ文脈に含まれる日付値(日付列が ctx.table 上なら ctx.rows、別表なら全体)
  // 現在のフィルタ文脈(ctx.rows)を、別テーブルの日付列へリレーション経由で写像
  function dateFactBridge(ctx, table) {
    if (!ctx.table || table === ctx.table) return null;
    const rel = findRelationship(ctx, ctx.table.name, table.name);
    if (!rel) return null;
    const factIsFrom = normalizeName(rel.fromTable) === normalizeName(ctx.table.name);
    return {
      factCol: resolveColumn(ctx.table, factIsFrom ? rel.fromColumn : rel.toColumn),
      dateKeyCol: resolveColumn(table, factIsFrom ? rel.toColumn : rel.fromColumn),
    };
  }

  function contextDateValues(ctx, node) {
    const { table, key } = resolveDateColumn(ctx, node);
    if (!table || !key) return [];
    let rows;
    if (table === ctx.table) {
      rows = ctx.rows;
    } else {
      const bridge = dateFactBridge(ctx, table);
      if (bridge) {
        const factKeys = new Set((ctx.rows || []).map((r) => String(r[bridge.factCol] ?? "")));
        rows = table.records.filter((r) => factKeys.has(String(r[bridge.dateKeyCol] ?? "")));
      } else {
        rows = table.records || [];
      }
    }
    return rows.map((r) => toDate(r[key])).filter(Boolean);
  }

  // 期間述語に合致する行を返す。日付列が別テーブルなら合致する日付キーをファクト行へ写像。
  function dateRowsInRange(ctx, node, inRange) {
    const { table, key } = resolveDateColumn(ctx, node);
    if (!table || !key) return ctx.rows;
    const dateRows = table.records.filter((r) => { const d = toDate(r[key]); return d && inRange(d); });
    if (table === ctx.table) {
      // 同一テーブル: 日付フィルタは置換しつつ、他のフィルタ(ctx.rowsの非日付列)は維持
      if (!ctx.rows || ctx.rows.length === table.records.length) return dateRows;
      const others = (table.columns || []).map((c) => c.name).filter((n) => n !== key);
      const sig = (r) => others.map((c) => String(r[c] ?? "")).join("");
      const allowed = new Set(ctx.rows.map(sig));
      return dateRows.filter((r) => allowed.has(sig(r)));
    }
    // 別テーブル: 合致した日付キーを、現在のフィルタ済みファクト行(ctx.rows)へ写像
    const bridge = dateFactBridge(ctx, table);
    if (!bridge) return dateRows;
    const dateKeys = new Set(dateRows.map((r) => String(r[bridge.dateKeyCol] ?? "")));
    return (ctx.rows || []).filter((r) => dateKeys.has(String(r[bridge.factCol] ?? "")));
  }

  // 期間単位(DAY/MONTH/QUARTER/YEAR)。素の識別子(name)はトークン文字列をそのまま使う
  function daxUnitOf(arg, ctx) {
    if (arg && (arg.type === "name" || arg.type === "tableName")) return arg.name;
    return String(arg ? (evalDaxNode(arg, ctx) ?? "DAY") : "DAY");
  }

  function shiftDate(date, n, unit) {
    const u = String(unit || "DAY").toUpperCase().replace(/['"]/g, "");
    if (u === "YEAR") return addMonths(date, n * 12);
    if (u === "QUARTER") return addMonths(date, n * 3);
    if (u === "MONTH") return addMonths(date, n);
    return new Date(date.getTime() + n * 86400000); // DAY
  }

  // テーブル引数が指すテーブルモデルを返す(行式の列解決をそのテーブルに切り替えるため)
  function tableOfArg(node, ctx) {
    if (!node) return ctx.table;
    if (node.type === "name" || node.type === "tableName") {
      return ctx.model?.get(node.name) || ctx.model?.get(normalizeName(node.name)) || ctx.table;
    }
    if (node.type === "call") {
      const n = node.name;
      if (n === "FILTER" || n === "ALL" || n === "VALUES" || n === "DISTINCT" || n === "ALLSELECTED" || n === "ALLEXCEPT" || n === "REMOVEFILTERS") return tableOfArg(node.args[0], ctx);
      if (n === "TOPN") return tableOfArg(node.args[1], ctx);
      if (n === "RELATEDTABLE") return ctx.model?.get(node.args[0]?.name) || ctx.model?.get(normalizeName(node.args[0]?.name || "")) || ctx.table;
      if (["DATESYTD", "DATESMTD", "DATESQTD", "SAMEPERIODLASTYEAR", "DATEADD", "DATESINPERIOD", "PREVIOUSMONTH", "PREVIOUSYEAR", "PREVIOUSQUARTER"].includes(n)) {
        return resolveDateColumn(ctx, node.args[0]).table || ctx.table;
      }
    }
    return ctx.table;
  }

  function resolveTableArg(node, ctx) {
    if (!node) return ctx.rows;
    if (node.type === "call") {
      const name = node.name;
      if (name === "FILTER") {
        const base = resolveTableArg(node.args[0], ctx);
        const tbl = tableOfArg(node.args[0], ctx);
        return base.filter((row) => truthy(evalDaxNode(node.args[1], { ...ctx, table: tbl, row, rows: base })));
      }
      if (name === "TOPN") {
        const count = Math.max(0, Math.trunc(toNum(evalDaxNode(node.args[0], ctx))));
        const base = resolveTableArg(node.args[1], ctx);
        const tbl = tableOfArg(node.args[1], ctx);
        const orderExpr = node.args[2];
        const desc = node.args[3] ? toNum(evalDaxNode(node.args[3], ctx)) !== 0 : true; // 既定はDESC
        const scored = base.map((row) => ({ row, key: orderExpr ? evalDaxNode(orderExpr, { ...ctx, table: tbl, row, rows: base }) : 0 }));
        scored.sort((a, b) => (desc ? -1 : 1) * compareValues(a.key, b.key));
        return scored.slice(0, count).map((entry) => entry.row);
      }
      if (name === "RELATEDTABLE") {
        const target = ctx.model?.get(node.args[0]?.name) || ctx.model?.get(normalizeName(node.args[0]?.name || ""));
        if (!target) return [];
        if (!ctx.table) return target.records;
        const rel = findRelationship(ctx, ctx.table.name, target.name);
        if (!rel) return target.records;
        const targetIsFrom = normalizeName(rel.fromTable) === normalizeName(target.name);
        const targetCol = targetIsFrom ? rel.fromColumn : rel.toColumn;
        const localCol = targetIsFrom ? rel.toColumn : rel.fromColumn;
        const tkey = resolveColumn(target, targetCol);
        const lkey = resolveColumn(ctx.table, localCol);
        // 行コンテキストがあれば現在行、なければ現在のフィルタ文脈(ctx.rows)の値集合で結合
        const localVals = ctx.row ? [ctx.row[lkey]] : (ctx.rows || []).map((r) => r[lkey]);
        const valSet = new Set(localVals.map((v) => String(v ?? "")));
        return target.records.filter((r) => valSet.has(String(r[tkey] ?? "")));
      }
      if (name === "ALLEXCEPT") {
        // ALLEXCEPT(table, cols…): 指定列のフィルタだけ残し、他は解除。テーブルは引数で解決。
        const a0 = node.args[0];
        let allexTable = ctx.table;
        if (a0?.type === "name" || a0?.type === "tableName") allexTable = ctx.model?.get(a0.name) || ctx.model?.get(normalizeName(a0.name)) || ctx.table;
        else if (a0?.type === "col" && a0.table) allexTable = ctx.model?.get(a0.table) || ctx.model?.get(normalizeName(a0.table)) || ctx.table;
        const recs = allexTable?.records || ctx.rows || [];
        const keepCols = node.args.slice(1).map((a) => resolveColumn(allexTable, a.name)).filter(Boolean);
        if (!keepCols.length) return recs;
        const allowed = keepCols.map((c) => new Set((ctx.rows || []).map((r) => String(r[c] ?? ""))));
        return recs.filter((r) => keepCols.every((c, i) => allowed[i].has(String(r[c] ?? ""))));
      }
      // --- タイムインテリジェンス(日付集合を返す) ---
      if (name === "DATESYTD" || name === "DATESMTD" || name === "DATESQTD") {
        const dates = contextDateValues(ctx, node.args[0]);
        if (!dates.length) return ctx.rows;
        const maxD = new Date(Math.max(...dates.map((d) => d.getTime())));
        let startMs;
        if (name === "DATESYTD") startMs = Date.UTC(maxD.getUTCFullYear(), 0, 1);
        else if (name === "DATESQTD") startMs = Date.UTC(maxD.getUTCFullYear(), Math.floor(maxD.getUTCMonth() / 3) * 3, 1);
        else startMs = Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth(), 1);
        return dateRowsInRange(ctx, node.args[0], (d) => d.getTime() >= startMs && d.getTime() <= maxD.getTime());
      }
      if (name === "SAMEPERIODLASTYEAR") {
        const dates = contextDateValues(ctx, node.args[0]);
        // 閏日(2/29)は前年に存在せず月がずれるため除外(DAXと同じ)
        const shifted = new Set();
        for (const d of dates) {
          const t = Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate());
          if (new Date(t).getUTCMonth() === d.getUTCMonth()) shifted.add(t);
        }
        return dateRowsInRange(ctx, node.args[0], (d) => shifted.has(d.getTime()));
      }
      if (name === "DATEADD") {
        const n = Math.trunc(toNum(evalDaxNode(node.args[1], ctx)));
        const unit = daxUnitOf(node.args[2], ctx);
        const dates = contextDateValues(ctx, node.args[0]);
        const shifted = new Set(dates.map((d) => shiftDate(d, n, unit).getTime()));
        return dateRowsInRange(ctx, node.args[0], (d) => shifted.has(d.getTime()));
      }
      if (name === "DATESINPERIOD") {
        const start = toDate(evalDaxNode(node.args[1], ctx));
        const n = toNum(evalDaxNode(node.args[2], ctx));
        const unit = daxUnitOf(node.args[3], ctx);
        if (!start) return ctx.rows;
        // 遠い端点は排他: 1日縮めて窓に正確に |n| 日(または1か月等)が入るように
        let end = shiftDate(start, n, unit);
        end = new Date(end.getTime() + (n >= 0 ? -86400000 : 86400000));
        const lo = Math.min(start.getTime(), end.getTime());
        const hi = Math.max(start.getTime(), end.getTime());
        return dateRowsInRange(ctx, node.args[0], (d) => d.getTime() >= lo && d.getTime() <= hi);
      }
      if (name === "PREVIOUSMONTH" || name === "PREVIOUSYEAR" || name === "PREVIOUSQUARTER") {
        const dates = contextDateValues(ctx, node.args[0]);
        if (!dates.length) return ctx.rows;
        const minD = new Date(Math.min(...dates.map((d) => d.getTime())));
        let lo;
        let hi;
        if (name === "PREVIOUSYEAR") { lo = Date.UTC(minD.getUTCFullYear() - 1, 0, 1); hi = Date.UTC(minD.getUTCFullYear() - 1, 11, 31); }
        else if (name === "PREVIOUSQUARTER") { const q = Math.floor(minD.getUTCMonth() / 3) * 3 - 3; const base = new Date(Date.UTC(minD.getUTCFullYear(), q, 1)); lo = base.getTime(); hi = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 3, 0); }
        else { lo = Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth() - 1, 1); hi = Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), 0); }
        return dateRowsInRange(ctx, node.args[0], (d) => d.getTime() >= lo && d.getTime() <= hi);
      }
      if (name === "ALL" || name === "ALLSELECTED" || name === "REMOVEFILTERS" || name === "VALUES" || name === "DISTINCT") {
        // 引数のテーブル(またはTable[Col]の所属テーブル)の全行を返す。引数省略時は文脈テーブル。
        const a = node.args[0];
        let t = null;
        if (a?.type === "name" || a?.type === "tableName") t = ctx.model?.get(a.name) || ctx.model?.get(normalizeName(a.name));
        else if (a?.type === "col" && a.table) t = ctx.model?.get(a.table) || ctx.model?.get(normalizeName(a.table));
        return (t || ctx.table)?.records || ctx.rows;
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
      case "MIN":
      case "MAX": {
        // 日付列なら日付として比較し、Dateを返す(0/1899-12-30にならない)
        const allDates = present.length && present.every((v) => v instanceof Date || (typeof v === "string" && /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(v)));
        if (allDates) {
          const ts = present.map((v) => toDate(v)).filter(Boolean).map((d) => d.getTime());
          if (ts.length) return new Date(func === "MIN" ? Math.min(...ts) : Math.max(...ts));
        }
        return numbers.length ? (func === "MIN" ? Math.min(...numbers) : Math.max(...numbers)) : null;
      }
      case "PRODUCT": return numbers.reduce((a, b) => a * b, 1);
      case "MEDIAN": {
        if (!numbers.length) return null;
        const sorted = [...numbers].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      }
      case "GEOMEAN": {
        const pos = numbers.filter((x) => x > 0);
        if (!pos.length) return null;
        return Math.exp(pos.reduce((a, b) => a + Math.log(b), 0) / pos.length);
      }
      default: return numbers.reduce((a, b) => a + b, 0);
    }
  }

  function evalDaxCall(node, ctx) {
    const name = node.name;
    const args = node.args || [];

    if (name === "CALCULATE") {
      let rows = ctx.rows;
      let activeRel = ctx.activeRel;
      const rest = args.slice(1);
      // USERELATIONSHIPは位置に依らず先に解決(その後のフィルタへ反映)
      for (const filter of rest) {
        if (filter.type === "call" && filter.name === "USERELATIONSHIP") {
          activeRel = relationshipForColumns(ctx, filter.args[0], filter.args[1]) || activeRel;
        }
      }
      for (const filter of rest) {
        if (filter.type === "call" && filter.name === "USERELATIONSHIP") continue;
        rows = applyCalcFilter(rows, filter, { ...ctx, activeRel });
      }
      // 行コンテキストは保持(CALCULATE内のRELATED等が関連行をたどれるように)
      return evalDaxNode(args[0], { ...ctx, rows, activeRel });
    }

    if (name === "COUNTROWS") {
      const rows = args.length ? resolveTableArg(args[0], ctx) : ctx.rows;
      return rows.length;
    }

    if (name === "RELATED") {
      const arg = args[0];
      if (!arg) return null;
      let targetName = arg.type === "col" ? arg.table : null;
      const colName = arg.type === "col" ? arg.name : arg.type === "ref" ? arg.name : null;
      if (!colName) return null;
      if (!targetName) {
        // 修飾なし [列]: ctx.table と関係する側でその列を持つテーブルを探す
        for (const rel of ctx.relationships || []) {
          const here = normalizeName(ctx.table?.name);
          const cand = normalizeName(rel.fromTable) === here ? rel.toTable : normalizeName(rel.toTable) === here ? rel.fromTable : null;
          if (!cand) continue;
          const t = ctx.model?.get(cand) || ctx.model?.get(normalizeName(cand));
          if (t && resolveColumn(t, colName)) { targetName = cand; break; }
        }
      }
      if (!targetName) return null;
      const row = relatedRow(ctx, targetName);
      if (!row) return null;
      const target = ctx.model?.get(targetName) || ctx.model?.get(normalizeName(targetName));
      return row[resolveColumn(target, colName)] ?? null;
    }

    // MIN/MAX は2引数のスカラー形(行コンテキスト不問)を集計形より優先
    if ((name === "MIN" || name === "MAX") && args.length === 2) {
      const a = toNum(evalDaxNode(args[0], ctx));
      const b = toNum(evalDaxNode(args[1], ctx));
      return name === "MIN" ? Math.min(a, b) : Math.max(a, b);
    }

    if (DAX_AGGREGATIONS.has(name)) {
      // 集計列が別テーブルを修飾している場合は、そのテーブルの行を反復する
      const arg = args[0];
      let tbl = ctx.table;
      let rows = ctx.rows;
      if (arg && arg.type === "col" && arg.table) {
        const qt = ctx.model?.get(arg.table) || ctx.model?.get(normalizeName(arg.table));
        if (qt && qt !== ctx.table) { tbl = qt; rows = qt.records || []; }
      }
      const values = rows.map((row) => evalDaxNode(arg, { ...ctx, table: tbl, row, rows }));
      return aggregateValues(name, values);
    }

    if (DAX_ITERATORS.has(name)) {
      const rows = resolveTableArg(args[0], ctx);
      const tbl = tableOfArg(args[0], ctx) || ctx.table;
      const values = rows.map((row) => evalDaxNode(args[1], { ...ctx, table: tbl, row, rows }));
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
      const pattern = String(evalDaxNode(args[1], ctx) || "");
      // 1) 名前付き書式(General Number/Currency/Percent/Yes-No 等)を最優先で判定
      const named = formatNamed(value, pattern);
      if (named != null) return named;
      // 2) 日付値、または年トークン/年月日を含むパターンの日付文字列は日付として整形
      const isDatePattern = /年|月|日/.test(pattern) || (/[yY]/.test(pattern) && !/[#0%]/.test(pattern));
      const date = value instanceof Date ? value : (isDatePattern ? toDate(value) : null);
      if (date) return formatDatePattern(date, pattern);
      // 3) 数値書式(プレースホルダ #,##0.00 等)
      const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
      if (Number.isFinite(numeric) && String(value).trim() !== "") {
        return formatMeasureValue(numeric, pattern);
      }
      return String(value);
    }

    if (name === "IF") {
      return truthy(evalDaxNode(args[0], ctx)) ? evalDaxNode(args[1], ctx) : (args[2] ? evalDaxNode(args[2], ctx) : null);
    }

    if (name === "SWITCH") {
      const test = evalDaxNode(args[0], ctx);
      const isTrueSwitch = test === true; // SWITCH(TRUE(), cond, result, ...)
      let i = 1;
      for (; i + 1 < args.length; i += 2) {
        const matched = isTrueSwitch
          ? truthy(evalDaxNode(args[i], ctx))
          : compareValues(test, evalDaxNode(args[i], ctx)) === 0;
        if (matched) return evalDaxNode(args[i + 1], ctx);
      }
      return i < args.length ? evalDaxNode(args[i], ctx) : null; // trailing default
    }

    if (name === "AND") return args.every((a) => truthy(evalDaxNode(a, ctx)));
    if (name === "OR") return args.some((a) => truthy(evalDaxNode(a, ctx)));
    if (name === "NOT") return !truthy(evalDaxNode(args[0], ctx));

    // TOTALYTD/MTD/QTD(expr, dateCol, [filter]) = CALCULATE(expr, DATES*TD(dateCol))
    if (name === "TOTALYTD" || name === "TOTALMTD" || name === "TOTALQTD") {
      const datesFn = name === "TOTALYTD" ? "DATESYTD" : name === "TOTALQTD" ? "DATESQTD" : "DATESMTD";
      let rows = resolveTableArg({ type: "call", name: datesFn, args: [args[1]] }, ctx);
      for (const extra of args.slice(2)) rows = applyCalcFilter(rows, extra, ctx);
      return evalDaxNode(args[0], { ...ctx, rows, row: null });
    }

    if (name === "IFERROR") {
      // This evaluator never throws DAX errors (DIVIDE-by-zero etc. return BLANK),
      // so IFERROR faithfully returns its first argument (BLANK is not an error).
      return evalDaxNode(args[0], ctx);
    }

    if (name === "COALESCE") {
      for (const arg of args) { const value = evalDaxNode(arg, ctx); if (!isBlank(value)) return value; }
      return null;
    }

    if (name === "BLANK") return null;
    if (name === "TRUE") return true;
    if (name === "FALSE") return false;

    if (name === "ABS") return Math.abs(toNum(evalDaxNode(args[0], ctx)));
    if (name === "INT") return Math.floor(toNum(evalDaxNode(args[0], ctx)));
    if (name === "ROUND") return roundHalf(toNum(evalDaxNode(args[0], ctx)), toNum(evalDaxNode(args[1], ctx)));
    if (name === "ROUNDUP") { const f = 10 ** toNum(evalDaxNode(args[1], ctx)); return Math.ceil(toNum(evalDaxNode(args[0], ctx)) * f) / f; }
    if (name === "ROUNDDOWN") { const f = 10 ** toNum(evalDaxNode(args[1], ctx)); return Math.floor(toNum(evalDaxNode(args[0], ctx)) * f) / f; }

    // --- 数学 ---
    if (name === "POWER") return toNum(evalDaxNode(args[0], ctx)) ** toNum(evalDaxNode(args[1], ctx));
    if (name === "SQRT") return Math.sqrt(toNum(evalDaxNode(args[0], ctx)));
    if (name === "EXP") return Math.exp(toNum(evalDaxNode(args[0], ctx)));
    if (name === "LN") return Math.log(toNum(evalDaxNode(args[0], ctx)));
    if (name === "LOG10") return Math.log10(toNum(evalDaxNode(args[0], ctx)));
    if (name === "LOG") { const x = toNum(evalDaxNode(args[0], ctx)); const base = args[1] ? toNum(evalDaxNode(args[1], ctx)) : 10; return Math.log(x) / Math.log(base); }
    if (name === "MOD") { const a = toNum(evalDaxNode(args[0], ctx)); const b = toNum(evalDaxNode(args[1], ctx)); return b === 0 ? null : a - b * Math.floor(a / b); }
    if (name === "QUOTIENT") { const a = toNum(evalDaxNode(args[0], ctx)); const b = toNum(evalDaxNode(args[1], ctx)); return b === 0 ? null : Math.trunc(a / b); }
    if (name === "SIGN") return Math.sign(toNum(evalDaxNode(args[0], ctx)));
    if (name === "TRUNC") { const x = toNum(evalDaxNode(args[0], ctx)); const n = args[1] ? toNum(evalDaxNode(args[1], ctx)) : 0; const f = 10 ** n; return Math.trunc(x * f) / f; }
    if (name === "CEILING") { const x = toNum(evalDaxNode(args[0], ctx)); const sig = args[1] ? toNum(evalDaxNode(args[1], ctx)) : 1; return sig === 0 ? 0 : Math.ceil(x / sig) * sig; }
    if (name === "FLOOR") { const x = toNum(evalDaxNode(args[0], ctx)); const sig = args[1] ? toNum(evalDaxNode(args[1], ctx)) : 1; return sig === 0 ? 0 : Math.floor(x / sig) * sig; }
    if (name === "PI") return Math.PI;
    if (name === "EVEN") { const x = Math.ceil(Math.abs(toNum(evalDaxNode(args[0], ctx)))); const e = x % 2 ? x + 1 : x; return Math.sign(toNum(evalDaxNode(args[0], ctx))) < 0 ? -e : e; }
    if (name === "ODD") { const x = Math.ceil(Math.abs(toNum(evalDaxNode(args[0], ctx)))); const o = x % 2 ? x : x + 1; return Math.sign(toNum(evalDaxNode(args[0], ctx))) < 0 ? -(o || 1) : (o || 1); }

    // --- 日付/時刻 ---
    if (name === "DATE") return makeUTCDate(toNum(evalDaxNode(args[0], ctx)), toNum(evalDaxNode(args[1], ctx)), toNum(evalDaxNode(args[2], ctx)));
    if (name === "TIME") { const h = toNum(evalDaxNode(args[0], ctx)); const m = toNum(evalDaxNode(args[1], ctx)); const s = args[2] ? toNum(evalDaxNode(args[2], ctx)) : 0; return (h * 3600 + m * 60 + s) / 86400; }
    if (name === "TODAY" || name === "NOW") { const now = new Date(); return name === "TODAY" ? makeUTCDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()) : now; }
    if (name === "YEAR") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? d.getUTCFullYear() : null; }
    if (name === "MONTH") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? d.getUTCMonth() + 1 : null; }
    if (name === "DAY") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? d.getUTCDate() : null; }
    if (name === "HOUR") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? d.getUTCHours() : null; }
    if (name === "MINUTE") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? d.getUTCMinutes() : null; }
    if (name === "SECOND") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? d.getUTCSeconds() : null; }
    if (name === "WEEKDAY") { const d = toDate(evalDaxNode(args[0], ctx)); if (!d) return null; const type = args[1] ? toNum(evalDaxNode(args[1], ctx)) : 1; const dow = d.getUTCDay(); return type === 2 ? (dow === 0 ? 7 : dow) : type === 3 ? (dow + 6) % 7 : dow + 1; }
    if (name === "WEEKNUM") { const d = toDate(evalDaxNode(args[0], ctx)); if (!d) return null; const start = Date.UTC(d.getUTCFullYear(), 0, 1); return Math.floor((d.getTime() - start) / 86400000 / 7) + 1; }
    if (name === "DATEVALUE") return toDate(evalDaxNode(args[0], ctx));
    if (name === "EDATE") { const d = toDate(evalDaxNode(args[0], ctx)); return d ? addMonths(d, Math.trunc(toNum(evalDaxNode(args[1], ctx)))) : null; }
    if (name === "EOMONTH") { const d = toDate(evalDaxNode(args[0], ctx)); if (!d) return null; const moved = addMonths(d, Math.trunc(toNum(evalDaxNode(args[1], ctx)))); return new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)); }
    if (name === "DATEDIFF") { const d1 = toDate(evalDaxNode(args[0], ctx)); const d2 = toDate(evalDaxNode(args[1], ctx)); if (!d1 || !d2) return null; return dateDiff(d1, d2, String(args[2] ? evalDaxNode(args[2], ctx) : "DAY")); }

    // --- テキスト ---
    if (name === "CONCATENATE") return `${daxStr(evalDaxNode(args[0], ctx))}${daxStr(evalDaxNode(args[1], ctx))}`;
    if (name === "LEN") return daxStr(evalDaxNode(args[0], ctx)).length;
    if (name === "UPPER") return daxStr(evalDaxNode(args[0], ctx)).toUpperCase();
    if (name === "LOWER") return daxStr(evalDaxNode(args[0], ctx)).toLowerCase();
    if (name === "TRIM") return daxStr(evalDaxNode(args[0], ctx)).replace(/^ +| +$/g, "");
    if (name === "LEFT") { const s = daxStr(evalDaxNode(args[0], ctx)); const n = args[1] ? Math.trunc(toNum(evalDaxNode(args[1], ctx))) : 1; return s.slice(0, Math.max(0, n)); }
    if (name === "RIGHT") { const s = daxStr(evalDaxNode(args[0], ctx)); const n = args[1] ? Math.trunc(toNum(evalDaxNode(args[1], ctx))) : 1; return n <= 0 ? "" : s.slice(-n); }
    if (name === "MID") { const s = daxStr(evalDaxNode(args[0], ctx)); const start = Math.trunc(toNum(evalDaxNode(args[1], ctx))); const len = Math.trunc(toNum(evalDaxNode(args[2], ctx))); return s.slice(Math.max(0, start - 1), Math.max(0, start - 1) + Math.max(0, len)); }
    if (name === "REPT") { const s = daxStr(evalDaxNode(args[0], ctx)); const n = Math.max(0, Math.trunc(toNum(evalDaxNode(args[1], ctx)))); return s.repeat(n); }
    if (name === "SUBSTITUTE") { const s = daxStr(evalDaxNode(args[0], ctx)); const oldT = daxStr(evalDaxNode(args[1], ctx)); const newT = daxStr(evalDaxNode(args[2], ctx)); return oldT === "" ? s : s.split(oldT).join(newT); }
    if (name === "REPLACE") { const s = daxStr(evalDaxNode(args[0], ctx)); const start = Math.trunc(toNum(evalDaxNode(args[1], ctx))); const len = Math.trunc(toNum(evalDaxNode(args[2], ctx))); const newT = daxStr(evalDaxNode(args[3], ctx)); return s.slice(0, Math.max(0, start - 1)) + newT + s.slice(Math.max(0, start - 1) + Math.max(0, len)); }
    if (name === "FIND" || name === "SEARCH") { let hay = daxStr(evalDaxNode(args[1], ctx)); let needle = daxStr(evalDaxNode(args[0], ctx)); const start = args[2] ? Math.trunc(toNum(evalDaxNode(args[2], ctx))) : 1; if (name === "SEARCH") { hay = hay.toLowerCase(); needle = needle.toLowerCase(); } const idx = hay.indexOf(needle, Math.max(0, start - 1)); if (idx < 0) return args[3] ? evalDaxNode(args[3], ctx) : null; return idx + 1; }
    if (name === "VALUE") { const v = evalDaxNode(args[0], ctx); const num = typeof v === "number" ? v : Number(String(v).replace(/,/g, "")); return Number.isFinite(num) ? num : null; }
    if (name === "UNICHAR") { const code = Math.trunc(toNum(evalDaxNode(args[0], ctx))); return code > 0 ? String.fromCodePoint(code) : ""; }

    // --- 反復(テーブル)系 ---
    if (name === "CONCATENATEX") {
      const rows = resolveTableArg(args[0], ctx);
      const tbl = tableOfArg(args[0], ctx) || ctx.table;
      const delim = args[2] ? daxStr(evalDaxNode(args[2], { ...ctx, table: tbl, row: rows[0] })) : "";
      return rows.map((row) => daxStr(evalDaxNode(args[1], { ...ctx, table: tbl, row, rows }))).join(delim);
    }
    if (name === "RANKX") {
      const rows = resolveTableArg(args[0], ctx);
      const tbl = tableOfArg(args[0], ctx) || ctx.table;
      const scoreExpr = args[1];
      const scores = rows.map((row) => toNum(evalDaxNode(scoreExpr, { ...ctx, table: tbl, row, rows })));
      const current = args[2] ? toNum(evalDaxNode(args[2], ctx)) : toNum(evalDaxNode(scoreExpr, ctx));
      const desc = args[3] ? toNum(evalDaxNode(args[3], ctx)) === 0 : true; // 既定DESC(1=ASC)
      let rank = 1;
      for (const score of scores) {
        if (desc ? score > current : score < current) rank += 1;
      }
      return rank;
    }

    // --- 情報/論理 ---
    if (name === "ISBLANK") return isBlank(evalDaxNode(args[0], ctx));
    if (name === "ISNUMBER") { const v = evalDaxNode(args[0], ctx); return typeof v === "number" && Number.isFinite(v); }
    if (name === "ISTEXT") return typeof evalDaxNode(args[0], ctx) === "string";
    if (name === "ISERROR") return false;
    if (name === "ISEVEN") return Math.trunc(toNum(evalDaxNode(args[0], ctx))) % 2 === 0;
    if (name === "ISODD") return Math.abs(Math.trunc(toNum(evalDaxNode(args[0], ctx))) % 2) === 1;
    if (name === "SELECTEDVALUE") {
      const rows = ctx.rows || [];
      const col = args[0];
      const values = new Set(rows.map((row) => daxStr(evalDaxNode(col, { ...ctx, row }))));
      if (values.size === 1) return evalDaxNode(col, { ...ctx, row: rows[0] });
      return args[1] ? evalDaxNode(args[1], ctx) : null;
    }
    if (name === "HASONEVALUE") {
      const rows = ctx.rows || [];
      const col = args[0];
      const values = new Set(rows.map((row) => daxStr(evalDaxNode(col, { ...ctx, row }))));
      return values.size === 1;
    }

    return null;
  }

  function daxStr(value) {
    if (value == null) return "";
    if (value instanceof Date) return formatDate(value, "yyyy-MM-dd");
    return String(value);
  }

  function dateDiff(d1, d2, unit) {
    const u = String(unit || "DAY").toUpperCase().replace(/['"]/g, "");
    const ms = d2.getTime() - d1.getTime();
    switch (u) {
      case "SECOND": return Math.trunc(ms / 1000);
      case "MINUTE": return Math.trunc(ms / 60000);
      case "HOUR": return Math.trunc(ms / 3600000);
      case "DAY": return Math.trunc(ms / 86400000);
      case "WEEK": return Math.trunc(ms / 86400000 / 7);
      case "MONTH": return (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
      case "QUARTER": return Math.trunc(((d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth())) / 3);
      case "YEAR": return d2.getUTCFullYear() - d1.getUTCFullYear();
      default: return Math.trunc(ms / 86400000);
    }
  }

  function formatDate(date, pattern) {
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const map = {
      yyyy: date.getUTCFullYear(),
      MM: pad(date.getUTCMonth() + 1),
      M: date.getUTCMonth() + 1,
      dd: pad(date.getUTCDate()),
      d: date.getUTCDate(),
      HH: pad(date.getUTCHours()),
      mm: pad(date.getUTCMinutes()),
      ss: pad(date.getUTCSeconds()),
    };
    return String(pattern).replace(/yyyy|MM|dd|HH|mm|ss|M|d/g, (token) => map[token]);
  }

  // FORMAT用の日付パターン整形(VBA/DAX風、大文字小文字を問わず m/mm は月として扱う)
  const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function formatDatePattern(date, pattern) {
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return String(pattern).replace(/yyyy|yy|mmmm|mmm|mm|dddd|ddd|dd|hh|ss|m|d|h|y/gi, (token) => {
      switch (token.toLowerCase()) {
        case "yyyy": return date.getUTCFullYear();
        case "yy": return pad(date.getUTCFullYear() % 100);
        case "y": return date.getUTCFullYear();
        case "mmmm": return MONTHS_FULL[date.getUTCMonth()];
        case "mmm": return MONTHS_ABBR[date.getUTCMonth()];
        case "mm": return pad(date.getUTCMonth() + 1);
        case "m": return date.getUTCMonth() + 1;
        case "dddd":
        case "ddd":
        case "dd": return pad(date.getUTCDate());
        case "d": return date.getUTCDate();
        case "hh": return pad(date.getUTCHours());
        case "h": return date.getUTCHours();
        case "ss": return pad(date.getUTCSeconds());
        default: return token;
      }
    });
  }

  function roundHalf(value, decimals) {
    // DAXは0.5を「0から遠ざかる」方向に丸める(負値も)。Math.roundは+∞方向なので符号で補正。
    const factor = 10 ** decimals;
    const scaled = value * factor;
    return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / factor;
  }

  const CALC_TABLE_FNS = new Set([
    "FILTER", "TOPN", "RELATEDTABLE", "ALLEXCEPT", "REMOVEFILTERS", "ALL", "VALUES", "DISTINCT", "ALLSELECTED",
    "DATESYTD", "DATESMTD", "DATESQTD", "SAMEPERIODLASTYEAR", "DATEADD", "DATESINPERIOD",
    "PREVIOUSMONTH", "PREVIOUSYEAR", "PREVIOUSQUARTER",
  ]);

  // ブール述語のASTから、参照している(修飾子付き)テーブルを推定
  function predicateTable(node, ctx) {
    let found = null;
    const walk = (n) => {
      if (!n || found || typeof n !== "object") return;
      if (n.type === "col" && n.table) {
        const t = ctx.model?.get(n.table) || ctx.model?.get(normalizeName(n.table));
        if (t) { found = t; return; }
      }
      for (const k of ["l", "r", "e"]) if (n[k]) walk(n[k]);
      if (Array.isArray(n.args)) for (const a of n.args) walk(a);
    };
    walk(node);
    return found;
  }

  // タイムインテリジェンス関数: dateRowsInRange が既にファクト(ctx.table)空間の行を返すため再写像しない
  const TIME_INTEL_FNS = new Set([
    "DATESYTD", "DATESMTD", "DATESQTD", "SAMEPERIODLASTYEAR", "DATEADD", "DATESINPERIOD",
    "PREVIOUSMONTH", "PREVIOUSYEAR", "PREVIOUSQUARTER",
  ]);

  function applyCalcFilter(rows, node, ctx) {
    if (node.type === "call" && node.name === "USERELATIONSHIP") return rows; // CALCULATE側で処理
    if (node.type === "call" && node.name === "KEEPFILTERS") {
      return applyCalcFilter(rows, node.args[0], ctx);
    }
    // タイムインテリジェンスの結果は既にファクト空間 → そのまま採用(二重ブリッジを防ぐ)
    if (node.type === "call" && TIME_INTEL_FNS.has(node.name)) {
      return resolveTableArg(node, { ...ctx, rows });
    }

    let targetTable;
    let survivors;
    if (node.type === "call" && CALC_TABLE_FNS.has(node.name)) {
      targetTable = tableOfArg(node, ctx) || ctx.table;
      survivors = resolveTableArg(node, { ...ctx, rows });
    } else {
      targetTable = predicateTable(node, ctx) || ctx.table;
      if (ctx.table && targetTable && normalizeName(targetTable.name) === normalizeName(ctx.table.name)) {
        // 同一テーブルの述語: 現在の行集合と積をとる
        return rows.filter((row) => truthy(evalDaxNode(node, { ...ctx, row, rows })));
      }
      const base = targetTable?.records || [];
      survivors = base.filter((row) => truthy(evalDaxNode(node, { ...ctx, table: targetTable, row, rows: base })));
    }

    // 対象テーブルが文脈テーブルと同じなら、絞り込んだ行がそのまま新しい行集合
    if (!ctx.table || !targetTable || normalizeName(targetTable.name) === normalizeName(ctx.table.name)) {
      return survivors;
    }
    // 別テーブル(ディメンション)の絞り込みを、リレーションのキーでファクト行へ伝播
    const rel = findRelationship(ctx, ctx.table.name, targetTable.name);
    if (!rel) return rows;
    const factIsFrom = normalizeName(rel.fromTable) === normalizeName(ctx.table.name);
    const factCol = resolveColumn(ctx.table, factIsFrom ? rel.fromColumn : rel.toColumn);
    const dimCol = resolveColumn(targetTable, factIsFrom ? rel.toColumn : rel.fromColumn);
    const keys = new Set(survivors.map((r) => String(r[dimCol] ?? "")));
    return rows.filter((r) => keys.has(String(r[factCol] ?? "")));
  }

  // VBA/DAXの名前付き書式。該当しなければ null を返す。
  function formatNamed(value, pattern) {
    const named = String(pattern).trim().toLowerCase();
    const num = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    const fin = Number.isFinite(num);
    const grp = (n, dec) => groupThousands(roundTo(n, dec));
    switch (named) {
      case "general number": return fin ? String(roundTo(num, 6)) : String(value);
      case "currency": return fin ? `¥${grp(num, 2)}` : String(value);
      case "fixed": return fin ? num.toFixed(2) : String(value);
      case "standard": return fin ? grp(num, 2) : String(value);
      case "percent": return fin ? `${(num * 100).toFixed(2)}%` : String(value);
      case "scientific": return fin ? num.toExponential(2) : String(value);
      case "yes/no": return truthy(value) ? "Yes" : "No";
      case "true/false": return truthy(value) ? "True" : "False";
      case "on/off": return truthy(value) ? "On" : "Off";
      default: return null;
    }
  }

  function formatMeasureValue(value, formatString) {
    if (value == null) return "—";
    // 日付を返すメジャーは ISO 形式で表示
    if (value instanceof Date) return formatDate(value, "yyyy-MM-dd");
    // 文字列を返すメジャー(FORMAT連結など)はそのまま表示
    if (typeof value === "string" && !/^-?[\d,]+(\.\d+)?$/.test(value.trim())) return value;
    // 桁区切りカンマ付きの数値文字列("1,234")も数値として扱う
    const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(number)) return "—";
    if (!formatString) return groupThousands(roundTo(number, 2));

    const core = formatString.replace(/"[^"]*"/g, "").trim();
    const decimalPart = core.split(".")[1] || "";
    const minDecimals = (decimalPart.match(/0/g) || []).length; // 必須桁(0)
    const maxDecimals = (decimalPart.match(/[0#]/g) || []).length; // 必須+任意(#)
    const grouped = core.includes(",");
    const percent = core.includes("%");

    const scaled = percent ? number * 100 : number;
    let text = scaled.toFixed(maxDecimals);
    // '#' は任意桁: 末尾0を minDecimals まで削る
    if (maxDecimals > minDecimals && text.includes(".")) {
      text = text.replace(/0+$/, "");
      let [ip, dp = ""] = text.split(".");
      if (dp.length < minDecimals) dp = dp.padEnd(minDecimals, "0");
      text = dp ? `${ip}.${dp}` : ip;
    }
    if (grouped) text = groupThousands(text);

    // プレースホルダ([0#])の前後の文字を接頭/接尾辞として抽出(引用・\エスケープを解除)。
    const decodeLit = (s) => s.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1");
    const masked = formatString.replace(/"[^"]*"/g, (m) => " ".repeat(m.length)).replace(/\\./g, "  ");
    const firstPh = masked.search(/[0#]/);
    let lastPh = -1;
    for (let k = masked.length - 1; k >= 0; k -= 1) { if (masked[k] === "0" || masked[k] === "#") { lastPh = k; break; } }
    const prefix = firstPh > 0 ? decodeLit(formatString.slice(0, firstPh)) : "";
    const suffix = lastPh >= 0 && lastPh < formatString.length - 1 ? decodeLit(formatString.slice(lastPh + 1).replace(/%/g, "")) : "";
    return `${prefix}${text}${percent ? "%" : ""}${suffix}`;
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
    const collisions = new Set();
    for (const entry of entries) {
      if (!entry.isImage || !entry.dataUrl) continue;
      const base = basename(entry.path).toLowerCase();
      // 別フォルダの同名画像は basename 解決でどちらか一方に化けるため、衝突を可視化する
      if (index.has(base) && index.get(base) !== entry.dataUrl) collisions.add(base);
      index.set(base, entry.dataUrl);
      index.set(normalizeName(base), entry.dataUrl);
      index.set(entry.path.toLowerCase(), entry.dataUrl);
    }
    if (collisions.size) {
      issues.push({
        level: "warning",
        title: `同名の画像ファイルが複数あります (${collisions.size}件)`,
        detail: `${[...collisions].slice(0, 8).join(" / ")} — フォルダが違っても同じファイル名だと、ビジュアルに別の画像が表示されることがあります。`,
      });
    }

    const resolve = (name) => {
      if (!name) return "";
      const base = basename(name).toLowerCase();
      return index.get(base) || index.get(normalizeName(base)) || index.get(name.toLowerCase()) || "";
    };

    let missing = 0;
    for (const visual of report.visuals) {
      if (!visual.imageRef) continue;
      // data: / http(s): は直接ソース。それ以外は登録リソース名として解決。
      const direct = visual.imageRef.url || visual.imageRef.name || "";
      if (/^(data:|https?:\/\/)/i.test(direct)) {
        visual.imageData = direct;
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

    // page.json は存在するが壊れて解析できなかったページのディレクトリ名(pageOrderの誤検出抑止用)
    const brokenPageDirs = new Set();
    for (const entry of entries) {
      const m = entry.path.match(/\/pages\/([^/]+)\/page\.json$/i);
      if (m && entry.jsonError) {
        brokenPageDirs.add(m[1]); // ディレクトリ名
        // 壊れていてもraw textから name を回収して二重計上を防ぐ
        const nm = /"name"\s*:\s*"([^"]+)"/.exec(entry.text || "");
        if (nm) brokenPageDirs.add(nm[1]);
      }
    }

    const order = Array.isArray(report.pagesJson?.pageOrder) ? report.pagesJson.pageOrder.map(String) : [];
    if (order.length) {
      for (const id of order) {
        // 壊れた page.json は「JSONが壊れています」で既に報告済みなので、実在しない扱いにはしない
        if (!pageIds.includes(id) && !brokenPageDirs.has(id)) add("error", "pageOrderが実在しないページを参照", `pages.json の pageOrder に "${id}" がありますが、対応する page.json がありません。`);
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
          hiers: new Set((table.hierarchies || []).map((h) => normalizeName(h.name))),
        });
      }

      // メジャー名のモデル内重複(Power BIはメジャー名のグローバル一意を要求)。
      // 空白/アンダースコアの違いは別名なので identityName(畳み込みは大小のみ)で判定。
      const measureNameMap = new Map();
      for (const table of semantic.tables) {
        for (const measure of table.measures) {
          const nn = identityName(measure.name);
          if (!measureNameMap.has(nn)) measureNameMap.set(nn, []);
          measureNameMap.get(nn).push(`${table.name}[${measure.name}]`);
        }
      }
      for (const [, list] of measureNameMap) {
        if (list.length > 1) add("error", "メジャー名がモデル内で重複しています", list.join(" / "));
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
            let exists;
            if (field.kind === "measure") {
              exists = table.meas.has(nn);
            } else if (field.kind === "hierarchy") {
              // 階層名そのもの / "階層.レベル" 形式 / レベル列名 のいずれかが在ればOK
              const head = normalizeName(String(field.name).split(".")[0]);
              const tail = normalizeName(String(field.name).split(".").pop());
              exists = table.hiers.has(nn) || table.hiers.has(head) || table.cols.has(tail) || table.cols.has(nn);
            } else {
              exists = table.cols.has(nn) || table.meas.has(nn);
            }
            if (!exists) {
              // 階層参照は解決しきれないことがあるため、致命的エラーにはしない(検査の終了コードを誤って1にしない)
              const level = field.kind === "hierarchy" ? "warning" : "error";
              add(level, "存在しない列/メジャーを参照", `${visual.title || visual.id}: ${field.table}[${field.name}] がモデルにありません。`);
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
          const refs = String(stripDaxNoise(measure.expression) || "").match(/\[([^\]]+)\]/g) || [];
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
        if (from && rel.fromColumn && !from.cols.has(normalizeName(rel.fromColumn))) add("error", "リレーションの列が存在しません", `${rel.fromTable}[${rel.fromColumn}]（Power BIで開けない可能性）`);
        if (to && rel.toColumn && !to.cols.has(normalizeName(rel.toColumn))) add("error", "リレーションの列が存在しません", `${rel.toTable}[${rel.toColumn}]（Power BIで開けない可能性）`);
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

  // DAXのコメント(// , --, /* */)と文字列リテラルを空白化し、参照/演算子を安全に走査できるようにする
  function stripDaxNoise(expr) {
    return String(expr || "")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/--[^\n]*/g, " ")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  }

  // DAX式から [..] 参照を抽出する。{ qualified:[{table,name}], bare:[name] }
  function extractDaxRefs(expr) {
    const clean = stripDaxNoise(expr);
    const qualified = [];
    let masked = clean;
    const qre = /(?:'([^']+)'|([\p{L}_][\p{L}\p{N}_]*))\[([^\]]+)\]/gu;
    let m;
    while ((m = qre.exec(clean))) {
      qualified.push({ table: m[1] || m[2], name: m[3] });
      masked = masked.slice(0, m.index) + " ".repeat(qre.lastIndex - m.index) + masked.slice(qre.lastIndex);
    }
    const bare = [];
    const bre = /\[([^\]]+)\]/g;
    while ((m = bre.exec(masked))) bare.push(m[1]);
    return { qualified, bare };
  }

  // メジャー依存グラフ・推移的未使用・循環参照・未使用列・DAX lint をまとめて算出
  // 識別子キー: 大文字小文字のみ畳み込み、内側の空白/アンダースコアは保持(別名の衝突回避)
  function identityName(value) {
    return String(value || "").trim().replace(/^[\['"]+/, "").replace(/[\]'"]+$/, "").toLowerCase();
  }

  // ===================================================================
  // モデル静的解析(依存グラフ・推移的未使用・Tarjan循環検出・DAX lint)と
  // ベストプラクティス検査(computeBestPractices)
  // ===================================================================
  function computeModelAnalysis(report, semantic) {
    const tables = semantic.tables || [];
    const measuresList = [];
    const measureByNorm = new Map();      // normalizeName -> [ {table, measure} ] (緩い一致・全候補)
    const columnByKey = new Map();        // identity table|col -> {table, column}
    const columnByNorm = new Map();       // normalizeName(col) -> [ {table, column} ]

    for (const table of tables) {
      for (const measure of table.measures) {
        measure.used = false;
        measure.dependsOn = [];
        measure.referencedBy = [];
        measure.inCycle = false;
        measure.lint = [];
        const key = normalizeName(measure.name);
        if (!measureByNorm.has(key)) measureByNorm.set(key, []);
        measureByNorm.get(key).push({ table, measure });
        measuresList.push({ table, measure });
      }
      for (const column of table.columns) {
        column.used = false;
        columnByKey.set(`${identityName(table.name)}|${identityName(column.name)}`, { table, column });
        const nkey = normalizeName(column.name);
        if (!columnByNorm.has(nkey)) columnByNorm.set(nkey, []);
        columnByNorm.get(nkey).push({ table, column });
      }
    }

    const measureId = (t, mm) => `${identityName(t.name)}|${identityName(mm.name)}`;
    const measureLabel = (entry) => `${entry.table.name}[${entry.measure.name}]`;
    const byId = new Map(measuresList.map((e) => [measureId(e.table, e.measure), e]));
    // テーブル優先のメジャー解決(同名メジャーが複数テーブルにある場合は参照元と同じテーブルを優先)
    const findMeasure = (name, preferTable) => {
      const list = measureByNorm.get(normalizeName(name));
      if (!list || !list.length) return null;
      if (preferTable) {
        const same = list.find((e) => identityName(e.table.name) === identityName(preferTable));
        if (same) return same;
      }
      return list[0];
    };
    const findColumn = (tableName, colName) => {
      // テーブル修飾がある場合は、そのテーブルの完全一致のみ(別テーブルへフォールバックしない)
      if (tableName) {
        return columnByKey.get(`${identityName(tableName)}|${identityName(colName)}`) || null;
      }
      const list = columnByNorm.get(normalizeName(colName));
      return list && list.length ? list[0] : null;
    };
    const colKey = (entry) => `${identityName(entry.table.name)}|${identityName(entry.column.name)}`;

    // メジャーの依存(他メジャー)と参照列を収集。自己参照も依存として記録(循環検出のため)。
    const graph = new Map();              // measureId -> Set(measureId)
    const measureColumnRefs = new Map();  // measureId -> Set(columnKey)
    for (const entry of measuresList) {
      const { table, measure } = entry;
      const id = measureId(table, measure);
      const refs = extractDaxRefs(measure.expression);
      const deps = new Set();
      const cols = new Set();
      for (const q of refs.qualified) {
        const col = findColumn(q.table, q.name);
        if (col) { cols.add(colKey(col)); continue; }
        const mm = findMeasure(q.name, table.name);
        if (mm) {
          deps.add(measureId(mm.table, mm.measure));
          measure.lint.push({ rule: "qualified-measure", message: `メジャー参照 ${q.table}[${q.name}] はテーブル修飾子なし [${q.name}] が推奨です（メジャーはテーブルに属しません）。` });
        }
      }
      for (const name of refs.bare) {
        // 同一テーブルの完全一致列を最優先(別テーブルの同名メジャーへ誤束縛=偽の循環を防ぐ)
        const sameTableCol = columnByKey.get(`${identityName(table.name)}|${identityName(name)}`);
        if (sameTableCol) { cols.add(colKey(sameTableCol)); continue; }
        const mm = findMeasure(name, table.name);
        if (mm) { deps.add(measureId(mm.table, mm.measure)); continue; }
        const col = findColumn(table.name, name) || findColumn(null, name);
        if (col) cols.add(colKey(col));
      }
      // 除算lint: ブラケット内の識別子や引用テーブル名に含まれる '/' を除外してから判定
      const forDivision = stripDaxNoise(measure.expression).replace(/\[[^\]]*\]/g, "[]").replace(/'(?:[^']|'')*'/g, "''");
      if (/\//.test(forDivision)) {
        measure.lint.push({ rule: "division", message: "除算に `/` を使用しています。0除算・空対策に DIVIDE() の利用を検討してください。" });
      }
      graph.set(id, deps);
      measureColumnRefs.set(id, cols);
      measure.dependsOn = [...deps].map((d) => (byId.get(d) ? measureLabel(byId.get(d)) : d));
    }

    // 逆引き(referencedBy: 他メジャー)
    for (const entry of measuresList) {
      const id = measureId(entry.table, entry.measure);
      for (const dep of graph.get(id) || []) {
        const target = byId.get(dep);
        if (target) target.measure.referencedBy.push(measureLabel(entry));
      }
    }

    // ビジュアルが直接参照するメジャー(ルート)と列
    const measureRoots = new Set();
    const usedColumns = new Set();
    const markField = (field) => {
      if (!field) return;
      if (field.kind === "measure") {
        const mm = findMeasure(field.name);
        if (mm) { measureRoots.add(measureId(mm.table, mm.measure)); return; }
      }
      // aggregation / column / hierarchy は列参照、measureでも列にフォールバック
      const col = findColumn(field.table, field.name);
      if (col) { usedColumns.add(colKey(col)); return; }
      const mm = findMeasure(field.name);
      if (mm) measureRoots.add(measureId(mm.table, mm.measure));
    };
    for (const visual of report.visuals) {
      for (const role of visual.roles || []) for (const field of role.fields || []) markField(field);
      for (const field of visual.fields || []) markField(field);
    }

    // 推移的に到達可能なメジャーのみ「使用中」(死んだメジャーの参照では生かさない)
    const usedMeasures = new Set();
    const stack = [...measureRoots];
    while (stack.length) {
      const id = stack.pop();
      if (usedMeasures.has(id) || !byId.has(id)) continue;
      usedMeasures.add(id);
      for (const dep of graph.get(id) || []) if (!usedMeasures.has(dep)) stack.push(dep);
    }

    let unused = 0;
    for (const entry of measuresList) {
      entry.measure.used = usedMeasures.has(measureId(entry.table, entry.measure));
      if (!entry.measure.used) unused += 1;
    }

    // 循環参照: 反復版Tarjan SCC(深い依存連鎖でもスタックを溢れさせない)。
    // SCCのノードが2以上、または単一ノードに自己辺があれば循環とみなす。
    const labelOf = (id) => (byId.get(id) ? measureLabel(byId.get(id)) : id);
    const cycles = findMeasureCycles(graph, byId, labelOf);

    // 列の使用判定: ビジュアル + 使用中メジャーのDAX + リレーションシップ
    for (const entry of measuresList) {
      if (!entry.measure.used) continue;
      for (const ck of measureColumnRefs.get(measureId(entry.table, entry.measure)) || []) usedColumns.add(ck);
    }
    for (const rel of semantic.relationships || []) {
      const f = findColumn(rel.fromTable, rel.fromColumn); if (f) usedColumns.add(colKey(f));
      const t = findColumn(rel.toTable, rel.toColumn); if (t) usedColumns.add(colKey(t));
    }
    // 並べ替えキー(sortByColumn)として参照される列も使用中とみなす
    for (const table of tables) {
      for (const column of table.columns) {
        if (!column.sortByColumn) continue;
        const target = columnByKey.get(`${identityName(table.name)}|${identityName(column.sortByColumn)}`);
        if (target) usedColumns.add(colKey(target));
      }
    }
    let unusedColumns = 0;
    for (const table of tables) {
      for (const column of table.columns) {
        column.used = usedColumns.has(`${identityName(table.name)}|${identityName(column.name)}`);
        if (!column.used) unusedColumns += 1;
      }
    }

    const lint = measuresList.flatMap((e) => e.measure.lint.map((l) => ({ measure: measureLabel(e), ...l })));
    return { unused, unusedColumns, cycles, lint };
  }

  // 反復版Tarjan SCCで循環参照を検出。各メジャーに inCycle を立て、循環ごとにラベル配列を返す。
  function findMeasureCycles(graph, byId, labelOf) {
    let index = 0;
    const idx = new Map();
    const low = new Map();
    const onStack = new Set();
    const S = [];
    const cycles = [];
    for (const start of byId.keys()) {
      if (idx.has(start)) continue;
      const work = [{ v: start, edges: [...(graph.get(start) || [])].filter((d) => byId.has(d)), i: 0 }];
      idx.set(start, index); low.set(start, index); index += 1; S.push(start); onStack.add(start);
      while (work.length) {
        const frame = work[work.length - 1];
        if (frame.i < frame.edges.length) {
          const w = frame.edges[frame.i]; frame.i += 1;
          if (!idx.has(w)) {
            idx.set(w, index); low.set(w, index); index += 1; S.push(w); onStack.add(w);
            work.push({ v: w, edges: [...(graph.get(w) || [])].filter((d) => byId.has(d)), i: 0 });
          } else if (onStack.has(w)) {
            low.set(frame.v, Math.min(low.get(frame.v), idx.get(w)));
          }
        } else {
          const v = frame.v;
          if (low.get(v) === idx.get(v)) {
            const comp = [];
            let w;
            do { w = S.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
            const hasSelfEdge = (graph.get(v) || new Set()).has(v);
            if (comp.length > 1 || (comp.length === 1 && hasSelfEdge)) {
              cycles.push(comp.map(labelOf));
              for (const cid of comp) { const e = byId.get(cid); if (e) e.measure.inCycle = true; }
            }
          }
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1].v;
            low.set(parent, Math.min(low.get(parent), low.get(v)));
          }
        }
      }
    }
    return cycles;
  }

  // ベストプラクティス検査(BPA風): 低誤検出の信頼できるルールのみ
  function computeBestPractices(report, semantic) {
    const findings = [];
    const tables = semantic.tables || [];
    const rels = semantic.relationships || [];

    const noFmt = [];
    for (const t of tables) for (const m of t.measures || []) if (!m.formatString) noFmt.push(`${t.name}[${m.name}]`);
    if (noFmt.length) findings.push({ rule: "measure-format", level: "info", title: `書式文字列の無いメジャー ${noFmt.length}件`, detail: noFmt.slice(0, 12).join(" / "), targets: noFmt });

    const bidi = rels.filter((r) => /both/i.test(r.crossFilter || "") && r.fromTable).map((r) => `${r.fromTable} ↔ ${r.toTable}`);
    if (bidi.length) findings.push({ rule: "bidi-rel", level: "warning", title: `双方向クロスフィルタのリレーション ${bidi.length}件`, detail: `${bidi.join(" / ")}（曖昧さ・性能の観点で単方向を推奨）`, targets: bidi });

    const inactive = rels.filter((r) => r.isActive === false && r.fromTable).map((r) => `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`);
    if (inactive.length) findings.push({ rule: "inactive-rel", level: "info", title: `非アクティブなリレーション ${inactive.length}件`, detail: `${inactive.join(" / ")}（USERELATIONSHIPでのみ有効）`, targets: inactive });

    const usedCols = new Set();
    for (const v of report.visuals || []) for (const role of v.roles || []) for (const f of role.fields || []) {
      if (f.table && f.name && (f.kind === "column" || f.kind === "aggregation")) usedCols.add(`${identityName(f.table)}|${identityName(f.name)}`);
    }
    const hiddenUsed = [];
    for (const t of tables) for (const c of t.columns || []) {
      if (c.isHidden && usedCols.has(`${identityName(t.name)}|${identityName(c.name)}`)) hiddenUsed.push(`${t.name}[${c.name}]`);
    }
    if (hiddenUsed.length) findings.push({ rule: "hidden-used", level: "warning", title: `非表示の列をビジュアルで使用 ${hiddenUsed.length}件`, detail: hiddenUsed.join(" / "), targets: hiddenUsed });

    return findings;
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
        case "<>": hit = cmp !== 0; break;
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

  // ページのクロスフィルタ選択を、対象ビジュアルのレコードに適用(同テーブルは直接、別テーブルはリレーション経由)
  function applyCrossFilter(records, table, dataModel, visual) {
    const xf = state.crossFilter;
    if (!xf || !xf.table || xf.visualId === visual.id) return records;
    if (normalizeName(table.name) === normalizeName(xf.table)) {
      const col = resolveColumn(table, xf.column);
      if (!col) return records;
      return records.filter((r) => String(r[col] ?? "").trim() === String(xf.value).trim());
    }
    // 別テーブル: リレーションで結合キーをたどって絞り込む
    const model = dataModel.byName;
    const xfTable = model.get(xf.table) || model.get(normalizeName(xf.table));
    if (!xfTable) return records;
    const ft = normalizeName(table.name);
    const xt = normalizeName(xf.table);
    const cands = (model.relationships || []).filter((r) => {
      const a = normalizeName(r.fromTable);
      const b = normalizeName(r.toTable);
      return (a === ft && b === xt) || (a === xt && b === ft);
    });
    const rel = cands.find((r) => r.isActive !== false) || cands[0];
    if (!rel) return records;
    const factIsFrom = normalizeName(rel.fromTable) === ft;
    const factKey = resolveColumn(table, factIsFrom ? rel.fromColumn : rel.toColumn);
    const dimKeyCol = resolveColumn(xfTable, factIsFrom ? rel.toColumn : rel.fromColumn);
    const dimValCol = resolveColumn(xfTable, xf.column);
    if (!factKey || !dimKeyCol || !dimValCol) return records;
    const keys = new Set(xfTable.records.filter((r) => String(r[dimValCol] ?? "").trim() === String(xf.value).trim()).map((r) => String(r[dimKeyCol] ?? "")));
    return records.filter((r) => keys.has(String(r[factKey] ?? "")));
  }

  // 選択中のクロスフィルタが指定の table/column/value と一致するか
  function isCrossFilterActive(tableName, column, value) {
    const xf = state.crossFilter;
    return Boolean(xf && normalizeName(xf.table) === normalizeName(tableName) && normalizeName(xf.column) === normalizeName(column) && String(xf.value) === String(value));
  }

  // ===================================================================
  // ビジュアルデータ計算(各ビジュアル種別→描画用データ。クロスフィルタ適用)
  // ===================================================================
  function computeVisualData(visual, dataModel) {
    const categories = roleFieldsByKind(visual, "category");
    const values = roleFieldsByKind(visual, "value");
    if (!categories.length && !values.length) return null;

    const type = visual.type.toLowerCase();
    const table = resolveTableFor([...values, ...categories], dataModel);
    if (!table) return null;
    const model = dataModel.byName;

    // ビジュアルレベルフィルタ + ページのクロスフィルタ選択を filter context として適用
    const records = applyCrossFilter(applyVisualFilters(table.records, visual.filters, table), table, dataModel, visual);

    const valueField = values[0];
    // 小さな倍数のフィールドは軸カテゴリから除外(ロール順に依らず実カテゴリを軸に)
    const smFieldEarly = fieldByRole(visual, /small.?multipl/i);
    const axisCats = smFieldEarly ? categories.filter((f) => f.label !== smFieldEarly.label) : categories;
    const categoryField = axisCats[0];
    const categoryColumn = categoryField ? resolveColumn(table, categoryField.name) : null;

    // テーブル / マトリックス
    if (type.includes("table") || type.includes("pivot") || type.includes("matrix")) {
      const isMeasureKind = (field) => field.kind === "measure" || field.kind === "aggregation";
      const catFields = [...categories, ...values].filter((field) => !isMeasureKind(field));
      const measureFields = [...categories, ...values].filter(isMeasureKind);
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
        if (isMeasureKind(field)) {
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
        if (isMeasureKind(field)) return true;
        const col = catColumns[i];
        return records.some((r) => r[col] != null && r[col] !== "") && records.every((r) => r[col] == null || r[col] === "" || Number.isFinite(Number(r[col])));
      });
      const colDomains = allFields.map((_, i) => (numericCol[i] ? seriesDomain(rawRows.map((r) => r[i])) : null));

      // 合計行: メジャーは全レコードで評価、数値カテゴリ列は合計
      const totals = allFields.map((field, i) => {
        if (isMeasureKind(field)) {
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
      // スライサーのフィールドはロールに依らず最初の非メジャー列
      const slField = [...categories, ...values].find((f) => f.kind !== "measure" && f.kind !== "aggregation") || categoryField || valueField;
      const slCol = slField ? resolveColumn(table, slField.name) : null;
      const items = [];
      const seen = new Set();
      for (const record of records) {
        const text = String(slCol ? record[slCol] ?? "" : "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
        if (items.length >= 14) break;
      }
      return { kind: "slicer", field: slField?.display || "", table: table.name, column: slField?.name || "", items };
    }

    // マルチ行カード: 各メジャーを1行ずつ表示
    if (type.includes("multirow")) {
      const cards = values
        .map((field) => {
          const ev = evaluateField(field, records, table, model);
          return ev ? { text: formatMeasureValue(ev.value, ev.format), label: field.display } : null;
        })
        .filter(Boolean);
      if (!cards.length) return null;
      return { kind: "multicard", cards };
    }

    // 地図: 緯度経度があれば実座標、無ければ地域＋値のバブル
    if (type.includes("map")) {
      const latField = fieldByRole(visual, /lat/i);
      const lonField = fieldByRole(visual, /lon/i);
      // ラベルは緯度経度ではなく場所(カテゴリ)列から取る
      const locField = categories.find((f) => f.label !== latField?.label && f.label !== lonField?.label)
        || (latField ? null : categories[0] || values[0]);
      const locColumn = locField ? resolveColumn(table, locField.name) : null;
      const points = [];
      if (locColumn) {
        const groups = new Map();
        for (const record of records) {
          const label = String(record[locColumn] ?? "").trim();
          if (!label) continue;
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label).push(record);
        }
        for (const [label, recs] of groups) {
          let value = recs.length;
          if (valueField) { const ev = evaluateField(valueField, recs, table, model); value = ev ? Number(ev.value) || 0 : recs.length; }
          const lat = latField ? Number(recs[0][resolveColumn(table, latField.name)]) : NaN;
          const lon = lonField ? Number(recs[0][resolveColumn(table, lonField.name)]) : NaN;
          points.push({ label, value, lat, lon });
        }
      }
      if (!points.length) return null;
      const hasGeo = points.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      return { kind: "map", points: points.slice(0, 40), hasGeo };
    }

    // ゲージ: 値・最小・最大・目標をロール名から取得し弧を算出
    if (type.includes("gauge")) {
      const byRole = (re) => {
        for (const role of visual.roles || []) {
          if (re.test(role.role)) {
            const ev = evaluateField(role.fields[0], records, table, model);
            if (ev) return Number(ev.value);
          }
        }
        return null;
      };
      const ev = valueField ? evaluateField(valueField, records, table, model) : null;
      if (!ev) return null;
      const value = Number(ev.value) || 0;
      const min = byRole(/^min/i) ?? 0;
      const max = byRole(/^(max|target)/i) ?? (value > 0 ? value : 1);
      return { kind: "gauge", value, text: formatMeasureValue(ev.value, ev.format), label: valueField.display, min, max };
    }

    // カード / KPI(カテゴリなし)
    if ((type.includes("card") || type.includes("kpi")) || (!categoryColumn && valueField)) {
      const evaluated = valueField ? evaluateField(valueField, records, table, model) : null;
      if (!evaluated) return null;
      return { kind: "card", value: evaluated.value, text: formatMeasureValue(evaluated.value, evaluated.format), label: valueField.display };
    }

    // 小さな倍数(Small multiples): SMロールの値ごとにミニチャートへ分割
    const smField = smFieldEarly;
    if (smField && categoryColumn && valueField) {
      const smCol = resolveColumn(table, smField.name);
      const panelMap = new Map();
      for (const rec of records) {
        const pk = String(rec[smCol] ?? "").trim() || "(空白)";
        if (!panelMap.has(pk)) panelMap.set(pk, []);
        panelMap.get(pk).push(rec);
      }
      let globalMax = 0;
      let fmt = "";
      const panels = [];
      for (const [title, recs] of panelMap) {
        const catMap = new Map();
        for (const rec of recs) {
          const ck = String(rec[categoryColumn] ?? "").trim() || "(空白)";
          if (!catMap.has(ck)) catMap.set(ck, []);
          catMap.get(ck).push(rec);
        }
        const series = [...catMap.entries()].map(([label, crecs]) => {
          const ev = evaluateField(valueField, crecs, table, model);
          if (ev && !fmt) fmt = ev.format;
          const value = ev ? Number(ev.value) || 0 : 0;
          globalMax = Math.max(globalMax, Math.abs(value));
          return { label, value };
        });
        panels.push({ title, series });
      }
      if (panels.length > 1) {
        const shownPanels = panels.slice(0, 9);
        const shownMax = shownPanels.reduce((mx, p) => Math.max(mx, ...p.series.map((s) => Math.abs(s.value))), 0);
        return {
          kind: "smallMultiples",
          panels: shownPanels.map((p) => ({ ...p, max: shownMax || 1, format: fmt })),
          morePanels: Math.max(0, panels.length - shownPanels.length),
        };
      }
    }

    // カテゴリ系チャート(複数系列対応)
    if (categoryColumn && valueField) {
      const seriesField = seriesFieldOf(visual, null);
      // 軸カテゴリは系列フィールドを除いた最初のカテゴリ
      const axisField = categories.find((f) => (!seriesField || f.label !== seriesField.label) && (!smField || f.label !== smField.label)) || categoryField;
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

      // 並べ替え(棒/列は合計降順、折れ線/ウォーターフォール/散布図は出現順)＋上限
      const isScatter = type.includes("scatter") || type.includes("bubble");
      const keepOrder = isLine || isScatter || type.includes("waterfall");
      const keepCap = isScatter ? 50 : 24;
      if (!keepOrder) {
        const order = categoriesList
          .map((label, index) => ({ index, total: seriesList.reduce((sum, s) => sum + Math.abs(s.values[index]), 0) }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map((entry) => entry.index);
        categoriesList = order.map((i) => categoriesList[i]);
        seriesList = seriesList.map((s) => ({ ...s, values: order.map((i) => s.values[i]) }));
      } else if (categoriesList.length > keepCap) {
        categoriesList = categoriesList.slice(0, keepCap);
        seriesList = seriesList.map((s) => ({ ...s, values: s.values.slice(0, keepCap) }));
      }

      // スケール基準: 集合=単一最大 / 積み上げ=カテゴリ合計の最大 / 100%=1
      let max = 1;
      if (normalized) {
        max = 1;
      } else if (stacked) {
        max = Math.max(1, ...categoriesList.map((_, i) => seriesList.reduce((sum, s) => sum + Math.abs(s.values[i]), 0)));
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

  // ===================================================================
  // レンダリング(DOM依存。typeof document !== "undefined" のときのみ動作)
  // render → タブ/概要/ページ/キャンバス/各ビジュアル/インスペクタ/モデル
  // ===================================================================
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
    els.reportCanvas.style.aspectRatio = `${page.width || DEFAULT_PAGE.width} / ${page.height || DEFAULT_PAGE.height}`;
    els.reportCanvas.style.background = page.background?.color ? colorWithAlpha(page.background.color, page.background.transparency) : "";
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
    const fontScale = canvasWidthPx / (page.width || DEFAULT_PAGE.width);

    // クロスフィルタ選択を反映するため、描画時にデータを再計算(state.crossFilterを参照)。
    // データモデルはプロジェクト単位で1度だけ構築してキャッシュ。
    let dataModel = null;
    if (state.project?.semantic) {
      if (!state.project._dataModel) state.project._dataModel = buildDataModel(state.project.semantic);
      dataModel = state.project._dataModel;
    }

    for (const visual of page.visuals) {
      if (dataModel && dataModel.byName.size) visual.data = computeVisualData(visual, dataModel);
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

      // 背景: show=false は透明、show=true は色(透明度反映)。図形は塗りを背景に
      const bg = style.background || {};
      if (bg.explicit && bg.show === false) {
        box.style.background = "transparent";
      } else if (bg.color) {
        box.style.background = colorWithAlpha(bg.color, bg.transparency);
      } else if (lowerType.includes("shape") && style.fill) {
        box.style.background = style.fill;
      }
      // 枠線(visualContainerObjects.border): Power BIで「枠線」がオンのときだけ描く。
      // 色未指定時はPower BIの既定枠線色(薄いグレー)。枠線があればビューア用の薄影は外す。
      let bordered = false;
      if (style.border?.show === true) {
        const bw = Number.isFinite(style.border.width) ? Math.max(1, Math.round(style.border.width)) : 1;
        box.style.border = `${bw}px solid ${style.border.color || "#E0E0E0"}`;
        box.style.boxShadow = "none";
        bordered = true;
      }
      if (Number.isFinite(style.border?.radius)) box.style.borderRadius = `${style.border.radius}px`;
      // 図形の枠線(line/outline)を反映
      if (lowerType.includes("shape") && style.line?.show && style.line.color) {
        box.style.border = `${Math.max(1, Math.round(style.line.weight || 1))}px solid ${style.line.color}`;
        bordered = true;
      }
      // ドロップシャドウ(設定時のみ。設定されていれば薄影に優先)
      if (style.shadow?.show) {
        box.style.boxShadow = `0 2px 6px ${style.shadow.color}`;
      } else if (bordered) {
        box.style.boxShadow = "none";
      }


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
      // クロスフィルタ: スライサー等のマークをクリックでページを絞り込む(再帰再描画)
      box.querySelectorAll("[data-xf-val]").forEach((el) => {
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          const t = el.getAttribute("data-xf-table");
          const c = el.getAttribute("data-xf-col");
          const v = el.getAttribute("data-xf-val");
          const vis = el.getAttribute("data-xf-vis");
          const cur = state.crossFilter;
          if (cur && cur.table === t && cur.column === c && String(cur.value) === v) state.crossFilter = null;
          else state.crossFilter = { table: t, column: c, value: v, visualId: vis };
          renderCanvas();
        });
      });
      els.reportCanvas.append(box);
    }

    // アクティブなクロスフィルタの表示＋クリア
    if (state.crossFilter) {
      const xf = state.crossFilter;
      const meta = document.createElement("span");
      meta.className = "xf-indicator";
      meta.innerHTML = `クロスフィルタ: <b>${escapeHtml(xf.column)} = ${escapeHtml(String(xf.value))}</b> <button type="button" class="xf-clear">クリア ✕</button>`;
      meta.querySelector(".xf-clear").addEventListener("click", () => { state.crossFilter = null; renderCanvas(); });
      els.canvasMeta.append(" ");
      els.canvasMeta.append(meta);
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

  // ロール名が正規表現にマッチする最初のフィールド(緯度経度等の特殊ロール用)
  function fieldByRole(visual, re) {
    for (const role of visual.roles || []) {
      if (re.test(role.role)) return role.fields[0] || null;
    }
    return null;
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
      const src = visual.imageData || "";
      const isRemote = /^https?:\/\//i.test(src);
      if (src && !isRemote) {
        const fit = visual.imageRef?.scaling || "contain";
        return `<img class="mini-image-img" src="${escapeAttribute(src)}" alt="${escapeHtml(visual.title || "image")}" style="object-fit:${escapeAttribute(fit)}" />`;
      }
      // 外部URL画像は「非通信」ポリシー(CSP)で読み込まないため、プレースホルダを表示
      return `<div class="mini-image" aria-hidden="true">${isRemote ? `<span class="mini-image-note">外部画像（非表示）</span>` : ""}</div>`;
    }

    if (type.includes("shape")) {
      // 塗り色はビジュアルボックス自体に適用済み。未指定時のみプレースホルダを描画。
      return visual.style?.fill ? "" : `<div class="mini-shape" aria-hidden="true"></div>`;
    }

    const data = visual.data;

    // 小さな倍数: パネルごとにミニ棒グラフのグリッド
    if (data?.kind === "smallMultiples") {
      const panels = data.panels.map((p) =>
        `<div class="sm-panel"><div class="sm-title">${escapeHtml(p.title)}</div>${renderDataBars({ series: p.series, max: p.max, format: p.format }, theme, false, false)}</div>`,
      ).join("");
      const more = data.morePanels ? `<div class="sm-grid-more">他 ${data.morePanels} パネル</div>` : "";
      return `<div class="sm-grid">${panels}</div>${more}`;
    }

    if (type.includes("treemap")) {
      return renderTreemap(data, theme, categoryLabel, valueLabel);
    }

    if (type.includes("scatter") || type.includes("bubble")) {
      return renderScatter(data, theme);
    }

    if (type.includes("gauge")) {
      const valueText = data?.kind === "gauge" ? data.text : "—";
      return renderGauge(valueText, valueLabel, color, data?.kind === "gauge" ? data : null);
    }

    if (type.includes("card") || type.includes("kpi") || type.includes("multirowcard")) {
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
      const cardCell = (text, label) => {
        const valueHtml = `<div class="mini-card-value" style="${valueStyle}">${escapeHtml(text)}</div>`;
        const labelHtml = card.labelShow === false ? "" : `<div class="mini-card-label" style="${labelStyle}">${escapeHtml(label)}</div>`;
        return `<div class="mini-card">${card.labelPosition === "below" ? `${valueHtml}${labelHtml}` : `${labelHtml}${valueHtml}`}</div>`;
      };
      // マルチ行カード: 全メジャーを縦に
      if (data?.kind === "multicard") {
        return `<div class="mini-multicard">${data.cards.map((c) => cardCell(c.text, c.label)).join("")}</div>`;
      }
      const valueText = data?.kind === "card" ? data.text : "—";
      const label = (data?.kind === "card" && data.label) || valueLabel;
      return cardCell(valueText, label);
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
      const pieHtml = `<div class="mini-pie" style="background:conic-gradient(${escapeAttribute(stops)})" aria-hidden="true">${inner}</div>`;
      return `<div class="mini-pie-wrap legend-${escapeAttribute(showLegend ? position : "none")}">${pieHtml}${legend}</div>`;
    }

    if (type.includes("funnel") && data?.kind === "category" && data.series.length) {
      return renderFunnel(data, theme, visual.style?.dataLabels?.show !== false);
    }

    if (type.includes("waterfall") && data?.kind === "category" && data.series.length) {
      return wrapWithChartLegend(visual, data, theme, renderWaterfall(data, visual.style?.dataLabels?.show !== false));
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
      if (data?.kind === "map" && data.points.length) {
        const pts = data.points;
        const maxV = Math.max(...pts.map((p) => Math.abs(p.value)), 1);
        if (data.hasGeo) {
          const lats = pts.map((p) => p.lat);
          const lons = pts.map((p) => p.lon);
          const minLa = Math.min(...lats);
          const maxLa = Math.max(...lats);
          const minLo = Math.min(...lons);
          const maxLo = Math.max(...lons);
          const nx = (lo) => (maxLo === minLo ? 50 : ((lo - minLo) / (maxLo - minLo)) * 86 + 7);
          const ny = (la) => (maxLa === minLa ? 50 : (1 - (la - minLa) / (maxLa - minLa)) * 82 + 9);
          const dots = pts.map((p, i) => {
            const r = 8 + (Math.abs(p.value) / maxV) * 22;
            return `<span title="${escapeAttribute(`${p.label}: ${p.value}`)}" style="left:${nx(p.lon).toFixed(1)}%;top:${ny(p.lat).toFixed(1)}%;width:${r.toFixed(0)}px;height:${r.toFixed(0)}px;background:${escapeAttribute(theme[i % theme.length])}"></span>`;
          }).join("");
          return `<div class="mini-map">${dots}</div>`;
        }
        const bubbles = pts.slice(0, 12).map((p, i) => {
          const r = 26 + (Math.abs(p.value) / maxV) * 40;
          return `<div class="map-bubble" style="width:${r.toFixed(0)}px;height:${r.toFixed(0)}px;background:${escapeAttribute(theme[i % theme.length])}" title="${escapeAttribute(`${p.label}: ${p.value}`)}"><span>${escapeHtml(p.label)}</span></div>`;
        }).join("");
        return `<div class="mini-map-bubbles">${bubbles}</div>`;
      }
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
      const interactive = Boolean(data?.kind === "slicer" && data.table && data.column);
      const cells = items.slice(0, limit).map((item) => {
        const attrs = interactive
          ? ` data-xf-vis="${escapeAttribute(visual.id)}" data-xf-table="${escapeAttribute(data.table)}" data-xf-col="${escapeAttribute(data.column)}" data-xf-val="${escapeAttribute(item)}"`
          : "";
        const sel = interactive && isCrossFilterActive(data.table, data.column, item) ? " xf-active" : "";
        return horizontal
          ? `<span class="chip-item${sel}"${attrs}>${escapeHtml(item)}</span>`
          : `<span class="slicer-row${sel}"${attrs}><i></i>${escapeHtml(item)}</span>`;
      }).join("");
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
                run.font ? `font-family:${escapeAttribute(cssFontFamily(run.font))}` : "",
              ].filter(Boolean).join(";");
              return `<span style="${styles}">${escapeHtml(run.text)}</span>`;
            })
            .join("");
          return `<div class="mini-text-line" style="${paragraph.align ? `text-align:${escapeAttribute(paragraph.align)}` : ""}">${runs}</div>`;
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
          ? Math.max(1, seriesList.reduce((sum, ser) => sum + Math.abs(ser.values[ci]), 0))
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
    // 棒系列が無ければ折れ線だけを描く(全系列を棒として二重描画しない)
    const useBars = barSeries;
    const barMax = Math.max(1, ...useBars.flatMap((s) => s.values.map((v) => Math.abs(v))));
    const barData = { ...data, seriesList: useBars, multi: useBars.length > 1, max: barMax };
    const bars = !useBars.length ? "" : useBars.length > 1 ? renderMultiBars(barData, theme, false, false) : renderDataBars({ ...barData, series: data.categories.map((label, i) => ({ label, value: useBars[0].values[i], format: data.format })) }, theme, false, false);
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
    const tiles = series
      .map((point, index) => {
        const valueText = formatMeasureValue(point.value, data.format);
        return `<span class="treemap-tile" style="flex:${point.value};background:${escapeAttribute(theme[index % theme.length])}" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
          <b>${escapeHtml(point.label)}</b><i>${escapeHtml(valueText)}</i>
        </span>`;
      })
      .join("");
    return `<div class="mini-treemap labeled">${tiles}</div>`;
  }

  // ウォーターフォール: 累計の浮動バー(増=緑/減=赤)
  function renderWaterfall(data, showLabels) {
    const UP = "#1AAB40";
    const DOWN = "#D64550";
    const points = data.series.slice(0, 16);
    let cum = 0;
    const steps = points.map((p) => {
      const start = cum;
      cum += Number(p.value) || 0;
      return { label: p.label, value: Number(p.value) || 0, start, end: cum };
    });
    const lo = Math.min(0, ...steps.map((s) => Math.min(s.start, s.end)));
    const hi = Math.max(0, ...steps.map((s) => Math.max(s.start, s.end)));
    const range = hi - lo || 1;
    const bars = steps
      .map((s) => {
        const upper = Math.max(s.start, s.end);
        const lower = Math.min(s.start, s.end);
        const top = ((hi - upper) / range) * 100;
        const height = (Math.abs(s.end - s.start) / range) * 100;
        const color = s.value >= 0 ? UP : DOWN;
        const valueText = formatMeasureValue(s.value, data.format);
        return `<div class="wf-col" title="${escapeAttribute(`${s.label}: ${valueText}`)}">
          <span class="wf-bar" style="top:${top.toFixed(1)}%;height:${Math.max(1, height).toFixed(1)}%;background:${color}"></span>
          ${showLabels ? `<span class="wf-value" style="top:${Math.max(0, top - 7).toFixed(1)}%">${escapeHtml(valueText)}</span>` : ""}
          <span class="wf-label">${escapeHtml(s.label)}</span>
        </div>`;
      })
      .join("");
    return `<div class="mini-wf">${bars}</div>`;
  }

  function renderFunnel(data, theme, showLabels) {
    const rows = data.series
      .map((point, index) => {
        const width = Math.max(0, (Math.abs(point.value) / data.max) * 100).toFixed(1);
        const color = escapeAttribute(theme[index % theme.length]);
        const valueText = formatMeasureValue(point.value, data.format);
        return `<div class="funnel-row" title="${escapeAttribute(`${point.label}: ${valueText}`)}">
          <span class="funnel-label">${escapeHtml(point.label)}</span>
          <span class="funnel-track"><span class="funnel-bar" style="width:${width}%;background:${color}">${showLabels ? escapeHtml(valueText) : ""}</span></span>
        </div>`;
      })
      .join("");
    return `<div class="mini-funnel">${rows}</div>`;
  }

  function renderScatter(data, theme) {
    // X=第1メジャー, Y=第2メジャー, (任意)サイズ=第3 を実値で配置
    if (data?.kind === "category" && data.seriesList?.length >= 2) {
      const xs = data.seriesList[0].values;
      const ys = data.seriesList[1].values;
      const sizes = data.seriesList[2]?.values;
      const xDom = seriesDomain(xs);
      const yDom = seriesDomain(ys);
      const sDom = sizes ? seriesDomain(sizes) : null;
      const norm = (v, d) => (d.max === d.min ? 0.5 : (Number(v) - d.min) / (d.max - d.min));
      const dots = data.categories.slice(0, 50).map((label, i) => {
        const x = (6 + norm(xs[i], xDom) * 88).toFixed(1);
        const y = (92 - norm(ys[i], yDom) * 84).toFixed(1);
        const sz = (sizes ? 5 + norm(sizes[i], sDom) * 16 : 8).toFixed(0);
        return `<span style="left:${x}%;top:${y}%;width:${sz}px;height:${sz}px;background:${escapeAttribute(theme[0])}" title="${escapeAttribute(label || "")}"></span>`;
      }).join("");
      return `<div class="mini-scatter" aria-hidden="true">${dots}</div>`;
    }
    // フォールバック(X/Yが無い場合は擬似配置)
    const series = data?.kind === "category" ? data.series : [];
    const max = data?.max || 1;
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

  function renderGauge(valueText, label, color, gauge) {
    // 値の割合(value-min)/(max-min)を半円弧(180°)にマップ
    let ratio = 0.6;
    if (gauge && Number.isFinite(gauge.value)) {
      const span = (gauge.max - gauge.min) || 1;
      ratio = Math.max(0, Math.min(1, (gauge.value - gauge.min) / span));
    }
    const cx = 50, cy = 50, r = 44;
    const angle = Math.PI - ratio * Math.PI; // 左(180°)→右(0°)
    const ex = (cx + r * Math.cos(angle)).toFixed(2);
    const ey = (cy - r * Math.sin(angle)).toFixed(2);
    // 値の弧は最大でも半円(ratio*180°≤180°)なので large-arc-flag は常に0
    const largeArc = 0;
    const valuePath = ratio <= 0 ? "" : `<path d="M6 50 A${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}" fill="none" stroke="${escapeAttribute(color)}" stroke-width="10" stroke-linecap="round" />`;
    return `
      <div class="mini-gauge">
        <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <path d="M6 50 A${r} ${r} 0 0 1 94 50" fill="none" stroke="#e7e2d8" stroke-width="10" stroke-linecap="round" />
          ${valuePath}
        </svg>
        <div class="mini-gauge-value">${escapeHtml(valueText)}</div>
        <div class="mini-card-label">${escapeHtml(label)}</div>
      </div>
    `;
  }

  function cssFontFamily(name) {
    const safe = String(name || "").replace(/[^\w \-]/g, "").trim();
    return safe ? `'${safe}', sans-serif` : "";
  }

  function linePath(values, max) {
    if (!values.length) return "M5 58H116";
    const left = 5;
    const right = 116;
    const top = 8;
    const bottom = 58;
    // 単一データ点は水平線で可視化(M...のみだと描画されない)
    if (values.length === 1) {
      const v = typeof values[0] === "object" && values[0] ? values[0].value : values[0];
      const y = (bottom - Math.max(0, Math.abs(Number(v) || 0) / (max || 1)) * (bottom - top)).toFixed(1);
      return `M${left} ${y}L${right} ${y}`;
    }
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
    const total = series.reduce((sum, point) => sum + Math.max(0, point.value), 0);
    // 全て0/負の値のときは任意の色で塗りつぶさず、ニュートラルな空表示にする
    if (total <= 0) return "var(--line, #e6e1d6) 0% 100%";
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
    const totalUnusedCols = tables.reduce(
      (sum, table) => sum + table.columns.filter((column) => column.used === false).length,
      0,
    );
    const cycles = state.project?.measureUsage?.cycles || [];
    const lintCount = (state.project?.measureUsage?.lint || []).length;

    const chips = [];
    chips.push(totalUnused
      ? `未使用メジャー <b>${totalUnused}</b>`
      : `未使用メジャー <b>0</b>`);
    chips.push(totalUnusedCols ? `未使用列 <b>${totalUnusedCols}</b>` : `未使用列 <b>0</b>`);
    if (cycles.length) chips.push(`<span class="bad">循環参照 <b>${cycles.length}</b></span>`);
    if (lintCount) chips.push(`DAX提案 <b>${lintCount}</b>`);
    const bp = state.project?.bestPractices || [];
    if (bp.length) chips.push(`ベストプラクティス <b>${bp.length}</b>`);
    const roles = state.project?.semantic?.roles || [];
    const calcGroups = state.project?.semantic?.calculationGroups || [];
    const refresh = state.project?.semantic?.refreshPolicies || [];
    if (roles.length) chips.push(`RLSロール <b>${roles.length}</b>`);
    if (calcGroups.length) chips.push(`計算グループ <b>${calcGroups.length}</b>`);
    if (refresh.length) chips.push(`更新ポリシー <b>${refresh.length}</b>`);

    // テーブルのパスから所属セマンティックモデルを推定
    const modelLabelOf = (table) => (String(table.path || "").split("/").find((seg) => /\.SemanticModel$/i.test(seg)) || "");
    const modelLabels = [...new Set(tables.map(modelLabelOf).filter(Boolean))];
    if (modelLabels.length > 1) chips.push(`セマンティックモデル <b>${modelLabels.length}</b>`);

    const cycleNote = cycles.length
      ? `<div class="model-summary bad">循環参照: ${cycles.map((ring) => escapeHtml(ring.join(" → ") + " → " + ring[0])).join(" / ")}</div>`
      : "";
    const bpNote = bp.length
      ? `<div class="model-summary"><b>ベストプラクティス検査</b><ul class="bp-list">${bp.map((b) => `<li class="bp-${b.level}">${escapeHtml(b.title)}<span class="bp-detail">${escapeHtml(b.detail || "")}</span></li>`).join("")}</ul></div>`
      : "";
    const secNote = (roles.length || calcGroups.length || refresh.length)
      ? `<div class="model-summary">${roles.length ? `<div>🔒 RLSロール: ${roles.map((r) => `${escapeHtml(r.name)}（${r.permissions.length}テーブル）`).join(", ")}</div>` : ""}`
        + `${calcGroups.length ? `<div>Σ 計算グループ: ${calcGroups.map((c) => `${escapeHtml(c.table)}（${c.items.length}項目）`).join(", ")}</div>` : ""}`
        + `${refresh.length ? `<div>🔄 増分更新ポリシー: ${refresh.map((r) => escapeHtml(r.table)).join(", ")}</div>` : ""}</div>`
      : "";
    const summary = `<div class="model-summary">${chips.join("　·　")}</div>` + cycleNote + bpNote + secNote;

    const depLine = (label, items) => {
      if (!items || !items.length) return "";
      const shown = items.slice(0, 8).map(escapeHtml).join(", ");
      return `<div class="measure-deps"><span class="dep-label">${label}</span> ${shown}${items.length > 8 ? " …" : ""}</div>`;
    };

    const unusedOnly = state.modelUnusedOnly;
    const toggle = `<div class="model-toolbar"><button type="button" class="model-toggle ${unusedOnly ? "on" : ""}">${unusedOnly ? "☑" : "☐"} 未使用のみ表示</button></div>`;

    const renderTableArticle = (table) => {
        // 未使用のみ表示のときは未使用のメジャー/列だけに絞る(無ければテーブルごと省略)
        const showMeasures = unusedOnly ? table.measures.filter((m) => m.used === false) : table.measures;
        const showColumns = unusedOnly ? table.columns.filter((c) => c.used === false) : table.columns;
        if (unusedOnly && !showMeasures.length && !showColumns.length) return "";
        const measureRows = showMeasures
          .map((measure) => {
            const unused = measure.used === false;
            const meta = [measure.formatString].filter(Boolean).map(escapeHtml).join(" · ");
            const lintTags = (measure.lint || [])
              .map((l) => `<span class="tag info" title="${escapeHtml(l.message)}">${l.rule === "division" ? "DIVIDE推奨" : "修飾子"}</span>`)
              .join("");
            return `
              <div class="measure-row ${unused ? "unused" : ""}">
                <div class="measure-head">
                  <span class="measure-name">${escapeHtml(measure.name)}</span>
                  <span class="measure-tags">
                    ${unused ? `<span class="tag warn">未使用</span>` : ""}
                    ${measure.inCycle ? `<span class="tag err">循環参照</span>` : ""}
                    ${lintTags}
                    ${meta ? `<span class="field-kind">${meta}</span>` : ""}
                  </span>
                </div>
                ${depLine("依存:", measure.dependsOn)}
                ${depLine("参照元:", measure.referencedBy)}
                ${measure.expression ? `<pre class="measure-dax"><code>${escapeHtml(formatDaxDisplay(measure.expression))}</code></pre>` : ""}
              </div>
            `;
          })
          .join("");

        const columnRows = showColumns
          .slice(0, 60)
          .map(
            (column) => `
              <div class="field-row ${column.used === false ? "unused" : ""}">
                <span>${escapeHtml(column.name)}${column.used === false ? ` <span class="tag warn">未使用</span>` : ""}</span>
                <span class="field-kind">column${column.dataType ? ` · ${escapeHtml(column.dataType)}` : ""}</span>
              </div>
            `,
          )
          .join("");

        const unusedCount = table.measures.filter((measure) => measure.used === false).length;
        const unusedColCount = table.columns.filter((column) => column.used === false).length;

        return `
          <article class="model-table">
            <div class="model-head">
              <h3>${escapeHtml(table.name)}</h3>
              <span class="model-count">${table.columns.length} columns / ${table.measures.length} measures${unusedCount ? ` · <span class="count-warn">未使用M ${unusedCount}</span>` : ""}${unusedColCount ? ` · <span class="count-warn">未使用C ${unusedColCount}</span>` : ""}</span>
            </div>
            ${showMeasures.length ? `<div class="panel-title">メジャー (DAX)</div><div class="measure-list">${measureRows}</div>` : ""}
            ${showColumns.length ? `<div class="panel-title">列</div><div class="field-list">${columnRows}</div>` : (table.columns.length ? "" : '<span class="muted">列を検出できませんでした</span>')}
          </article>
        `;
    };

    // セマンティックモデルごとにグループ化(複数モデルのときだけ見出しを付ける)
    const groups = new Map();
    const groupOrder = [];
    for (const table of tables) {
      const html = renderTableArticle(table);
      if (!html) continue;
      const label = modelLabelOf(table) || "(モデル)";
      if (!groups.has(label)) { groups.set(label, []); groupOrder.push(label); }
      groups.get(label).push(html);
    }
    let body;
    if (!groupOrder.length) {
      body = `<div class="empty-table">未使用のメジャー・列はありません 🎉</div>`;
    } else if (groupOrder.length <= 1) {
      body = groups.get(groupOrder[0]).join("");
    } else {
      body = groupOrder.map((label) => {
        const arts = groups.get(label);
        return `<div class="model-group-head">📦 ${escapeHtml(label)} <span class="model-group-count">${arts.length} テーブル</span></div>${arts.join("")}`;
      }).join("");
    }

    els.modelExplorer.innerHTML = renderRelationships() + summary + toggle + body;
    const toggleBtn = els.modelExplorer.querySelector(".model-toggle");
    if (toggleBtn) toggleBtn.addEventListener("click", () => { state.modelUnusedOnly = !state.modelUnusedOnly; renderModelExplorer(); });
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
        ${renderERDiagram(usable)}
        <div class="rel-list">${rows}</div>
      </section>
    `;
  }

  // テーブルを円周に配置した簡易ER図(SVG)。テーブルが多すぎる場合は省略。
  function renderERDiagram(usable) {
    const names = [...new Set(usable.flatMap((r) => [r.fromTable, r.toTable]))];
    if (names.length < 2 || names.length > 14) return "";
    const W = 760;
    const H = Math.max(300, names.length * 30 + 140);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 80;
    const pos = new Map();
    names.forEach((n, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / names.length;
      pos.set(n, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    const edges = usable.map((r) => {
      const p = pos.get(r.fromTable);
      const q = pos.get(r.toTable);
      if (!p || !q) return "";
      const both = /both/i.test(r.crossFilter || "");
      const many = (r.toCardinality || "").toLowerCase() === "many";
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = 26;
      const x1 = (p.x + (dx / len) * off).toFixed(0);
      const y1 = (p.y + (dy / len) * off).toFixed(0);
      const x2 = (q.x - (dx / len) * off).toFixed(0);
      const y2 = (q.y - (dy / len) * off).toFixed(0);
      const dash = r.isActive === false ? ' stroke-dasharray="5 4"' : "";
      const label = many ? "*—*" : "*—1";
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="er-edge"${dash} marker-end="url(#erHead)"${both ? ' marker-start="url(#erHead)"' : ""} />`
        + `<text x="${((p.x + q.x) / 2).toFixed(0)}" y="${((p.y + q.y) / 2 - 4).toFixed(0)}" class="er-edge-label">${escapeHtml(label)}</text>`;
    }).join("");
    const nodes = names.map((n) => {
      const p = pos.get(n);
      const w = Math.min(170, Math.max(72, n.length * 14 + 24));
      return `<g><rect x="${(p.x - w / 2).toFixed(0)}" y="${(p.y - 16).toFixed(0)}" width="${w}" height="32" rx="7" class="er-node" />`
        + `<text x="${p.x.toFixed(0)}" y="${(p.y + 5).toFixed(0)}" class="er-node-label">${escapeHtml(n)}</text></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="er-diagram" role="img" aria-label="リレーション図">`
      + `<defs><marker id="erHead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">`
      + `<path d="M0,0 L8,3 L0,6" fill="none" stroke="currentColor" stroke-width="1.2" /></marker></defs>`
      + `${edges}${nodes}</svg>`;
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

  // ===================================================================
  // ユーティリティ(エスケープ・色変換・整形・パス/ファイル判定 など)
  // ===================================================================
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
    state.crossFilter = null;
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
