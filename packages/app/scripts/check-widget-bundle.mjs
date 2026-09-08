// Post-build invariant check for `npm run build:widget`.
//
// The anywidget _esm module is loaded from a blob URL inside Jupyter, where
// relative chunk imports (static or dynamic) cannot resolve. The bundle must
// therefore be exactly one self-contained ESM file (plus style.css) with no
// import statements pointing at sibling files. Rollup silently reintroduces
// chunks whenever someone adds a dynamic `import()` on a widget code path —
// that is how the widget broke after the #315 field-parity work.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../widget/detailviews/static/widget", import.meta.url));

const files = readdirSync(dir).sort();
const allowed = ["index.js", "style.css"];
const extras = files.filter((f) => !allowed.includes(f));

let failed = false;
if (extras.length > 0) {
  console.error(
    `check-widget-bundle: unexpected chunk files next to index.js: ${extras.join(", ")}\n` +
      "The widget bundle must be a single self-contained ESM file (blob-URL " +
      "loading cannot resolve sibling chunks). A new dynamic import() or " +
      "non-inlined worker likely caused Rollup to split the bundle."
  );
  failed = true;
}

const src = readFileSync(join(dir, "index.js"), "utf8");
const relativeImport = src.match(/(?:^|[^\w.])(?:import|export)\s*(?:[\s\S]{0,200}?from\s*)?["']\.\.?\//m);
if (relativeImport) {
  console.error(
    "check-widget-bundle: index.js contains a relative import/export — it is " +
      "not self-contained and will fail to load from a blob URL."
  );
  failed = true;
}

if (failed) process.exit(1);
console.log(
  `check-widget-bundle: OK — single self-contained bundle (${(src.length / 1024 / 1024).toFixed(1)} MB index.js)`
);
