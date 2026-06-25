# PBIP Viewer

PBIP Viewer is a static browser app for inspecting Power BI Project files.

It reads PBIP/PBIR project metadata in the browser and renders an approximate
report canvas, visual inventory, file inventory, and semantic model explorer.
No uploaded file is sent to a server.

## Supported input

- A PBIP project folder selected with **フォルダを開く**
- A zip archive containing a PBIP project
- Individual `.pbip`, `.pbir`, `.pbism`, `.bim`, `.json`, `.tmdl`, and `.platform` files

For a PBIP project that looks like this, select the parent folder with
**フォルダを開く**:

```text
Project Folder/
  MyReport.Report/
  MyReport.SemanticModel/
  MyReport.pbip
```

## What it can show

- `.Report/definition/pages/*/page.json`
- `.Report/definition/pages/*/visuals/*/visual.json`
- `.Report/definition.pbir`
- `.Report/definition/report.json`
- `.Report/report.json`
- `.SemanticModel/definition/**/*.tmdl`
- Legacy `model.bim` tables when present

## Limitations

PBIP projects usually do not contain imported data. This viewer does not run
the Power BI engine, DAX, custom visuals, or Power BI Embedded. The canvas is a
metadata preview of PBIR layout and bindings, not an exact Power BI rendering.

For exact rendering, open the project in Power BI Desktop or publish it to the
Power BI service.
