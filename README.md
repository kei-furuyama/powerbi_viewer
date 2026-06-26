# PBIP Viewer

PBIP Viewer is a static browser app for inspecting Power BI Project files.

It reads PBIP/PBIR project metadata in the browser and renders an approximate
report canvas, visual inventory, file inventory, and semantic model explorer.

## Privacy

All processing happens **locally in your browser**. The files you open are
**never uploaded or transmitted** to any server — there is no backend. (The
page itself and the JSZip library load from the web, but your project data
stays on your machine.)

## Supported input

- A PBIP project folder selected with **フォルダを開く**
- A zip archive containing a PBIP project
- Individual `.pbip`, `.pbir`, `.pbism`, `.bim`, `.json`, `.tmdl`, and `.platform` files

For a PBIP project that looks like this, select the **whole project folder**
with **フォルダを開く** (subfolders are read recursively):

```text
Project Folder/
  MyReport.pbip                                  ← project manifest
  MyReport.Report/
    definition.pbir                              ← dataset reference
    definition/report.json
    definition/pages/pages.json
    definition/pages/<page>/page.json            ← each page
    definition/pages/<page>/visuals/<id>/visual.json   ← each visual
    StaticResources/**                           ← theme JSON, images
  MyReport.SemanticModel/
    definition.pbism
    definition/model.tmdl
    definition/tables/*.tmdl                      ← tables / measures
    (or legacy model.bim)
```

## Files it reads

| Purpose | Files |
| --- | --- |
| Pages & layout | `.Report/definition/pages/*/page.json` |
| Visuals & bindings | `.Report/definition/pages/*/visuals/*/visual.json` |
| Dataset reference | `.Report/definition.pbir` |
| Report settings & theme | `.Report/definition/report.json`, `.Report/StaticResources/**` |
| Tables, columns, measures | `.SemanticModel/definition/**/*.tmdl` (or legacy `model.bim`) |
| Images (visuals / wallpaper) | `.png` `.jpg` `.jpeg` `.gif` `.svg` `.webp` `.bmp` under the project |
| Legacy layout | `.Report/report.json` (`sections`/`visualContainers`) |

To reproduce **actual numbers**, the semantic model must embed data in a TMDL
partition via `Table.FromRows(...)`. Models that only reference an external
source render shapes/labels without values.

After loading, the **検出事項 (Issues)** tab reports a PBIP integrity check
(broken JSON, missing files, references to non-existent tables/columns/measures,
page-order mismatches, etc.) so you can catch projects that would fail to open
in Power BI.

## Limitations

PBIP projects usually do not contain imported data. This viewer does not run
the Power BI engine, DAX, custom visuals, or Power BI Embedded. The canvas is a
metadata preview of PBIR layout and bindings, not an exact Power BI rendering.

For exact rendering, open the project in Power BI Desktop or publish it to the
Power BI service.
