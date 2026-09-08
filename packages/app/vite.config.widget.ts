// vite.config.widget.ts
//
// Build config for the anywidget (Jupyter) bundle, `npm run build:widget`.
// Differences from the web build (vite.config.ts):
// - workerFactories.ts is aliased to workerFactories.widget.ts, which uses
//   `?worker&inline` imports: the anywidget _esm module is loaded from a
//   blob URL in Jupyter where separate worker chunks cannot be resolved.
// - assetsInlineLimit forces all assets into the bundle for the same reason.
// - Output goes to ../widget/detailviews/static/widget/ (gitignored) — inside
//   the `detailviews` Python package (packages/widget), away from the web app
//   deployment under site/.
import path, { resolve } from "path";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "../widget/detailviews/static/widget",
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    lib: {
      entry: "src/index.tsx",
      formats: ["es"],
      name: "AdaptiveDetailViews",
      fileName: "index"
    },
    rollupOptions: {
      external: [],
      output: {
        // The _esm module is loaded from a blob URL: relative chunk imports
        // (static or dynamic) cannot resolve there, so lazy `import()`s
        // (e.g. fieldDistanceWorker, fieldPreviewClient) must be folded
        // into the single bundle file.
        inlineDynamicImports: true
      }
    }
  },
  plugins: [svgr()],
  define: {
    "process.env": JSON.stringify({ NODE_ENV: "production" })
  },
  resolve: {
    alias: [
      // Swap in the inline-worker factories (must precede generic aliases).
      {
        find: /^(.*)\/workerFactories$/,
        replacement: "$1/workerFactories.widget",
      },
      // Distributed widget bundle: swap the backend scaling seam for its open-core
      // stub (same guardrail as the web build; plan-315-tiled-backend.md).
      { find: "@scaling", replacement: resolve(__dirname, "src/scaling.stub.ts") },
      { find: "process", replacement: "process/browser" },
      { find: "textures", replacement: resolve(__dirname, "src/utils/icons/textures") },
      { find: "src", replacement: path.resolve(__dirname, "src") },
    ]
  }
});
