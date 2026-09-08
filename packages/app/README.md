# Web app (Vite/React/TypeScript)

Single-page application implementing the adaptive detail-views visualization.
The same source also builds the self-contained bundle embedded by the
`detailviews` Jupyter widget in `../widget/`.

## Commands

Run from the repository root (npm-workspaces; dependencies are hoisted there):

```bash
npm ci                # install dependencies
npm run dev           # dev server (http://localhost:5173)
npm run build         # typecheck + production build into packages/app/site/
npm run preview       # serve the production build
npm test              # jest test suite
npm run lint          # eslint
npm run build:widget  # self-contained widget bundle for the pip package
```

The same scripts work from this directory with `npm run <script>`.

## Layout

- `src/` — application source (components, workers, preprocessing, GL layers)
- `src/datasets/catalog.ts` — single source of truth for the predefined-dataset list
- `src/scaling.stub.ts` — the `@scaling` seam: this build ships no backend providers,
  every dataset is processed client-side
- `public/data/` — predefined datasets (copied into the build output)
- `site/` — deployed site (build output + hand-maintained `index.html` shell;
  build output is gitignored, only the shell and two test fixtures are tracked)
- `../../scripts/data-prep/` — offline preprocessing scripts for new datasets
- `../../tests/fixtures/` — golden fixtures read by the parity test suites
