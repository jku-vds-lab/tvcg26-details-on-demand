# Details on Demand

A scatterplot of projected data with automatically generated and placed
annotations. Clusters get contours, labels, and small detail visualizations
directly in the plot, and what they show adapts to where you zoom and what you
select. Trajectories (games, episodes, video streams) are drawn as curves
through the projection. Everything runs in the browser, and the deployed app is
a static page.

**Live demo:** https://jku-vds-lab.at/tvcg26-steinparz/

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/app/` | The web app (Vite, React, TypeScript) with the predefined datasets |
| `packages/widget/` | The `detailviews` Python package, a Jupyter widget built on [anywidget](https://anywidget.dev/) |
| `scripts/data-prep/` | Preprocessing scripts for bringing your own data into the app's dataset format |
| `tests/fixtures/` | Shared test data |

The repository is an npm-workspaces monorepo: install and run everything from
the repository root.

## Quickstart

Requires Node.js 18+.

```bash
npm ci
npm run dev       # dev server at http://localhost:5173
```

```bash
npm run build     # typecheck + production build into packages/app/site/
npm run preview   # serve the production build locally
npm test          # jest test suite
npm run lint      # eslint
```

The GitHub Pages deployment (`.github/workflows/deploy-gh-pages.yml`) runs the
same `npm ci && npm run build` and publishes `packages/app/site/`.

## Jupyter widget

The visualization is also available as a Jupyter widget, the `detailviews`
Python package. Pass a DataFrame with projected coordinates, optionally a
trajectory id and order column, and a label column, and the same visualization
renders in the notebook output cell. See [`packages/widget/detailviews/README.md`](packages/widget/detailviews/README.md)
and the examples under [`packages/widget/examples/`](packages/widget/examples/).

```bash
pip install detailviews
```

```python
import pandas as pd
from detailviews import DetailViewsWidget

df = pd.read_csv("my_projection.csv")   # columns: x, y, episode, step, ...
DetailViewsWidget.from_dataframe(df, x="x", y="y", trajectory="episode", order="step")
```

To build the package from this repository instead (for development):

```bash
npm run build:widget            # self-contained widget bundle -> packages/widget/detailviews/static/widget/
cd packages/widget
python -m pip install build
python -m build                 # -> dist/detailviews-0.1.0-py3-none-any.whl
python -m pip install dist/detailviews-0.1.0-py3-none-any.whl
```

## Included datasets

The predefined-datasets tab ships with:

| Dataset | Type | Contents |
| --- | --- | --- |
| 10×2 origins | Rubik's cube | 20 solves of a Rubik's cube, starting from two scrambles. Every point is one cube state, every curve is one solve, and each step along a curve is one rotation on the way to the solved cube. |
| 100×2 origins | Rubik's cube | The same, with 200 solves. |
| All openings | Chess | One game per opening from a snapshot of the [lichess chess-openings](https://github.com/lichess-org/chess-openings) list, every position projected as a point and every game drawn as a curve. |
| 450 games (40k, PSE) | Chess | 450 games with three different openings, 40k positions. The dataset used by [Projection Space Explorer](https://jku-vds-lab.at/projection-space-explorer/), included for comparison. |
| Guiding example | Synthetic | The small constructed example from the paper. |
| Digits (10k) | MNIST | UMAP projection of the MNIST test set. |
| Fashion (10k) | Fashion-MNIST | UMAP projection of the Fashion-MNIST test set. |
| Edinburgh Office | Video | Frames of an office webcam stream from the [Edinburgh Office dataset](https://homepages.inf.ed.ac.uk/rbf/OFFICEDATA/), projected from a latent space. |

The app also supports Gymnasium/MuJoCo episodes (Hopper, Pendulum, Walker2d,
LunarLander, FrozenLake, DoorKey), but these datasets are not available in
this deployed version. Their episode data is not part of the repository, and
their image insets need local render services.

Preprocessing scripts for bringing your own data into the shipped format are
under `scripts/data-prep/` (`preprocess_dataset_generate_knng.py`); the app
also accepts plain CSV uploads (x/y plus trajectory id and order columns) and
preprocesses them in-browser.

## Citation

If you use this tool in academic work, please cite:

```
[Citation for the TVCG submission will be added upon publication.]
```

## License

MIT, see [LICENSE](LICENSE).
