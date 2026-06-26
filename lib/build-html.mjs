// Build a self-contained single-file HTML preview that inlines app.js + CSS
// and the embedded entries, auto-loading via PBIPViewerParser.loadEntriesForPreview.
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildSelfContainedHtml(entries, { title = "PBIP Viewer" } = {}) {
  const [html, css, app] = await Promise.all([
    fsp.readFile(path.join(ROOT, "index.html"), "utf8"),
    fsp.readFile(path.join(ROOT, "styles.css"), "utf8"),
    fsp.readFile(path.join(ROOT, "app.js"), "utf8"),
  ]);

  // Safe-embed JSON inside <script>: never let "</" or "<!" break the tag.
  const data = JSON.stringify(entries).replace(/</g, "\\u003c");
  const bootstrap = `<script>\nconst __ENTRIES__ = ${data};\nwindow.addEventListener("DOMContentLoaded", () => {\n  try { window.PBIPViewerParser.loadEntriesForPreview(__ENTRIES__); }\n  catch (e) { console.error(e); }\n});\n<\/script>`;

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}<\/title>`)
    .replace(/<link rel="stylesheet"[^>]*>/i, `<style>\n${css}\n<\/style>`)
    // drop the JSZip CDN script (data is embedded; not needed offline)
    .replace(/<script src="https:\/\/[^"]*jszip[^"]*"[^>]*><\/script>\s*/i, "")
    .replace(/<script src="\.\/app\.js"[^>]*><\/script>/i, `<script>\n${app}\n<\/script>`)
    .replace(/<\/body>/i, `${bootstrap}\n</body>`);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
