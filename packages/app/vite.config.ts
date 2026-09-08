// vite.config.ts
import anywidget from "@anywidget/vite";
import path, { resolve } from 'path';
import { defineConfig } from "vite";
import svgr from 'vite-plugin-svgr';

export default defineConfig({
  base: "/tvcg26-details-on-demand/",
  publicDir: "public",
  build: {
    outDir: "site",
    // site/ (the GitHub Pages publish dir) is not a pure build output: it also
    // carries the tracked simpleDataset.integration test fixtures under
    // site/data/, which vite's default outDir wipe would delete from the
    // working tree on every `npm run build`. Everything else under site/ is
    // gitignored build output (only index.html and those fixtures are tracked).
    emptyOutDir: false,
    lib: {
      entry: "src/index.tsx",
      formats: ["es"],
      name: "AdaptiveDetailViews",
      fileName: "adaptive-detail-views"
    },
    rollupOptions: {
      // override Vite’s default externals list
      external: []
    }
  },
  plugins: [anywidget(), svgr()],
  optimizeDeps: {
    // umap-js is only imported inside umap.worker.ts; without pre-bundling,
    // the dev server discovers it on the first projection run and force-reloads
    // the page mid-session.
    include: ["umap-js"],
  },
  define: {
    "process.env": JSON.stringify({ NODE_ENV: "production" })
  },
  resolve: {
    alias: {
      // PUBLIC build: swap the backend scaling seam for its open-core no-op stub so
      // src/scaling/ is never bundled or distributed (plan-315-tiled-backend.md).
      "@scaling": resolve(__dirname, "src/scaling.stub.ts"),
      process: "process/browser",
      textures: resolve(__dirname, "src/utils/icons/textures"),
      src: path.resolve(__dirname, 'src'),
    }
  }
});
