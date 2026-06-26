// Build a self-contained single-file HTML preview that inlines app.js + CSS
// and the embedded entries, auto-loading via PBIPViewerParser.loadEntriesForPreview.
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Lock the offline file down: only inline script/style and data: images are
// allowed, and no network of any kind. This guarantees the advertised
// "self-contained / offline" behavior and neutralizes any remote image
// (beacon) URLs that a malicious PBIP might embed.
const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

export async function buildSelfContainedHtml(entries, { title = "PBIP Viewer" } = {}) {
  const [html, css, app] = await Promise.all([
    fsp.readFile(path.join(ROOT, "index.html"), "utf8"),
    fsp.readFile(path.join(ROOT, "styles.css"), "utf8"),
    fsp.readFile(path.join(ROOT, "app.js"), "utf8"),
  ]);

  // Safe-embed JSON inside <script>: never let "</" or "<!" break the tag.
  const data = JSON.stringify(entries).replace(/</g, "\\u003c");
  const bootstrap = `<script>\nconst __ENTRIES__ = ${data};\nwindow.addEventListener("DOMContentLoaded", () => {\n  try { window.PBIPViewerParser.loadEntriesForPreview(__ENTRIES__); }\n  catch (e) { console.error(e); }\n});\n<\/script>`;

  // Use function replacers everywhere: their return value is inserted verbatim,
  // so "$&", "$`", "$'", "$$", "$n", "$<name>" in titles or in app.js/styles.css
  // are never reinterpreted as replacement patterns.
  // Replace the page's (stricter, script-src 'self') CSP with the offline one
  // that permits the inlined scripts/styles. Two CSP metas would be intersected
  // by the browser and block inline execution, so we swap rather than add.
  const replacedCsp = /<meta[^>]*http-equiv="Content-Security-Policy"[\s\S]*?>/i.test(html);
  return html
    .replace(/<meta[^>]*http-equiv="Content-Security-Policy"[\s\S]*?>/i, () => CSP_META)
    .replace(/<title>[\s\S]*?<\/title>/i, () => `${replacedCsp ? "" : CSP_META + "\n    "}<title>${escapeHtml(title)}<\/title>`)
    .replace(/<link rel="stylesheet"[^>]*>/i, () => `<style>\n${css}\n<\/style>`)
    // drop the JSZip CDN script (data is embedded; not needed offline)
    .replace(/<script src="https:\/\/[^"]*jszip[^"]*"[^>]*><\/script>\s*/i, () => "")
    // also drop a locally-vendored jszip reference if present (offline build embeds data)
    .replace(/<script src="\.\/jszip[^"]*"[^>]*><\/script>\s*/i, () => "")
    .replace(/<script src="\.\/app\.js"[^>]*><\/script>/i, () => `<script>\n${app}\n<\/script>`)
    .replace(/<\/body>/i, () => `${bootstrap}\n</body>`);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
