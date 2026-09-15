import { useEffect } from "react";
import "./LandingPage.css";
import {
  FIGURE_CARDS,
  IRIS_ATTRIBUTION,
  IRIS_CSV_URL,
  IRIS_SECTION_ID,
  IRIS_TUTORIAL_STEPS,
  PAGE_TITLE_MAIN,
  PAGE_TITLE_SUB,
  TOOL_NAME,
  redirectUrl,
} from "./landingContent";

// PLACEHOLDER — fill in before release (empty string renders a "coming soon" chip).
const PAPER_PDF_URL = "";
// PLACEHOLDER — fill in before release.
const ARXIV_URL = "";
// PLACEHOLDER — fill in before release.
const DOI_URL = "";
// PLACEHOLDER — fill in before release.
const OSF_URL = "";
// PLACEHOLDER — demo video link TBD; while empty the hero button scrolls to the Video section.
const VIDEO_URL = "";
// PyPI name; tracks the pip package in packages/widget/detailviews/.
const PACKAGE_NAME = "detailviews";
const GITHUB_URL = "https://github.com/jku-vds-lab/tvcg26-details-on-demand";
// PLACEHOLDER — complete author list / year once the paper is published.
const BIBTEX = `@article{steinparz2026details,
  title   = {Details Where They Matter: Understanding Projection Spaces
             Using In-Place Summary Visualizations},
  author  = {Steinparz, Christian A. and TODO},
  journal = {IEEE Transactions on Visualization and Computer Graphics},
  year    = {2026},
  note    = {TODO: volume, pages, DOI}
}`;

const PIP_SNIPPET = `pip install ${PACKAGE_NAME}`;

const NOTEBOOK_SNIPPET = `import pandas as pd
from detailviews import DetailViewsWidget

df = pd.read_csv("iris.csv")  # x/y projection + feature columns

DetailViewsWidget.from_dataframe(
    df, x="x", y="y",
    trajectory="episode", order="step",  # optional: trajectory roles
    action="action", label="label",      # optional: annotation columns
)`;

/** External link, or a "coming soon" chip while the URL is still a placeholder. */
function LinkOrSoon({ href, label }: { href: string; label: string }) {
  if (!href) {
    return (
      <span className="landing-link-soon" title="Link not yet available">
        {label} (coming soon)
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/**
 * Project landing page, served at `#/` next to the tool (see
 * `landing/bootTarget.ts`). Rendered without the Redux Provider or any app
 * chrome — it must not import from the app tree beyond its own directory.
 */
export default function LandingPage() {
  // Deep links into a section (#/figures, #/paper, #/video, #/python): on a
  // direct page load the browser's native fragment scroll runs before React
  // has mounted the sections, so it finds nothing — repeat it after mount.
  // (In-page nav clicks scroll natively; section images carry aspect-ratios
  // so late loads don't shift the target away.)
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id.length > 1 && id.startsWith("/")) {
      document.getElementById(id)?.scrollIntoView();
    }
  }, []);

  return (
    <div className="landing-root">
      <header className="landing-topbar">
        <span className="landing-topbar-brand">
          {PAGE_TITLE_MAIN}: <span className="landing-title-sub">{PAGE_TITLE_SUB}</span>
        </span>
        <nav className="landing-topbar-nav">
          <a href="#/figures">Figures</a>
          <a href="#/iris">Upload data</a>
          <a href="#/paper">Paper</a>
          <a href="#/python">Python</a>
          <a className="landing-btn landing-btn-primary" href=".">
            Launch application
          </a>
        </nav>
      </header>

      <section className="landing-hero">
        <h1>{PAGE_TITLE_MAIN}</h1>
        <p className="landing-hero-subtitle">{PAGE_TITLE_SUB}</p>
        <p className="landing-hero-blurb">
          Our method adaptively shows details in place within projections of high-dimensional
          data. Clusters receive contours, text labels, and summary insets like on a map, and a
          degree of interest derived from user interactions such as queries, selections, and
          semantic zooming adapts the level of detail where it matters.
        </p>
        <div className="landing-hero-actions">
          <a className="landing-btn landing-btn-primary" href=".">
            Launch application
          </a>
          <a className="landing-btn landing-btn-outline" href="#/figures">
            Figure demos
          </a>
          <a
            className="landing-btn landing-btn-outline"
            href={VIDEO_URL || "#/video"}
            {...(VIDEO_URL ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            Video
          </a>
          <a className="landing-btn landing-btn-outline" href="#/paper">
            Paper
          </a>
        </div>
        <div className="landing-teaser">
          <a href="." title={`Launch ${TOOL_NAME}`}>
            <img src="landing/teaser.jpg" alt={`${TOOL_NAME} showing an annotated projection`} />
          </a>
        </div>
      </section>

      <section className="landing-section landing-section-alt" id="/figures">
        <h2>Animated figure demonstrations</h2>
        <p className="landing-section-intro">
          Each card shows a figure from the paper. Its links open the tool and demonstrate the
          user steps behind the figure, replaying the queries, selections, parameter changes,
          and zooming that lead to the shown view.
        </p>
        <div className="landing-card-grid">
          {FIGURE_CARDS.map((card) => (
            <div key={card.id} className="landing-card">
              <a className="landing-card-image" href={redirectUrl(card.links[0].slug)}>
                <img src={card.image} alt={card.title} loading="lazy" />
              </a>
              <div className="landing-card-body">
                <span className="landing-card-title">{card.title}</span>
                <span className="landing-card-desc">{card.description}</span>
                <span className="landing-card-links">
                  {card.links.map((l) => (
                    <a key={l.slug} className="landing-demo-link" href={redirectUrl(l.slug)}>
                      {l.label}
                    </a>
                  ))}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id={IRIS_SECTION_ID}>
        <h2>Upload your own data</h2>
        <p className="landing-section-intro">
          A five-minute walkthrough on the classic Iris flower table. Upload a CSV, let the
          tool compute a projection, and read the annotated result. Everything runs in the
          browser, with nothing to install.
        </p>
        <ol className="landing-steps">
          {IRIS_TUTORIAL_STEPS.map((step, i) => (
            <li key={step.title} className="landing-step">
              <p className="landing-step-title">
                <span className="landing-step-number">{i + 1}</span>
                {step.title}
              </p>
              <p className="landing-step-text">{step.text}</p>
              {i === 0 && (
                <p className="landing-step-download">
                  <a className="landing-btn landing-btn-outline" href={IRIS_CSV_URL} download="iris.csv">
                    Download iris.csv
                  </a>
                  <span className="landing-step-attribution">{IRIS_ATTRIBUTION}</span>
                </p>
              )}
              {step.image && (
                <img
                  src={step.image}
                  alt={step.alt}
                  loading="lazy"
                  style={
                    step.imageWidth && step.imageHeight
                      ? {
                          aspectRatio: `${step.imageWidth} / ${step.imageHeight}`,
                          maxWidth: step.imageWidth,
                        }
                      : undefined
                  }
                />
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section" id="/video">
        <h2>Video</h2>
        <ul className="landing-links">
          <li>
            <LinkOrSoon href={VIDEO_URL} label="Demo video" />
          </li>
        </ul>
      </section>

      <section className="landing-section" id="/paper">
        <h2>Paper &amp; supplemental materials</h2>
        <ul className="landing-links">
          <li>
            <LinkOrSoon href={PAPER_PDF_URL} label="Paper (PDF)" />
          </li>
          <li>
            <LinkOrSoon href={ARXIV_URL} label="arXiv preprint" />
          </li>
          <li>
            <LinkOrSoon href={DOI_URL} label="Publisher version (DOI)" />
          </li>
          <li>
            <LinkOrSoon href={OSF_URL} label="Supplemental materials (OSF)" />
          </li>
          <li>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              Source code on GitHub
            </a>
          </li>
        </ul>
        <details className="landing-bibtex">
          <summary>BibTeX</summary>
          <pre>
            <code>{BIBTEX}</code>
          </pre>
        </details>
      </section>

      <section className="landing-section landing-section-alt" id="/python">
        <h2>Python package &amp; Jupyter widget</h2>
        <p className="landing-section-intro">
          The tool also runs as an <a href="https://anywidget.dev">anywidget</a>-based Jupyter
          widget, published on PyPI as <code>{PACKAGE_NAME}</code>. Hand it a DataFrame with a 2D projection and it
          computes the kNN graph, trajectory splines, and HDBSCAN clustering inside the widget,
          off the UI thread.
        </p>
        <pre className="landing-code">
          <code>{PIP_SNIPPET}</code>
        </pre>
        <pre className="landing-code">
          <code>{NOTEBOOK_SNIPPET}</code>
        </pre>
        <p>
          For reinforcement learning runs recorded with the package, cluster insets are
          generated automatically from the environment itself: a small local render service
          restores each recorded state (from state snapshots, or by replaying the episode
          seed and actions) and calls the standard Gymnasium <code>render()</code> function,
          returning one averaged frame per cluster on demand. Datasets therefore stay small,
          as no rendered images are ever stored or shipped. The current limitations: the
          render service must run locally next to the app (one command per dataset), so
          these datasets work in local checkouts and notebooks but not on this hosted demo,
          and environments without a state API must be deterministic for seed replay.
        </p>
        <div className="landing-widget-shot">
          <img
            src="landing/widget-demo.jpg"
            alt="The widget rendered in a JupyterLab output cell, showing the UMAP-projected iris dataset with summary insets per variety cluster"
            loading="lazy"
          />
          <p>The widget rendered in a Jupyter notebook on the UMAP-projected iris dataset.</p>
        </div>
      </section>

      <footer className="landing-footer">
        <p>
          Developed at the{" "}
          <a href="https://jku-vds-lab.at" target="_blank" rel="noreferrer">
            JKU Visual Data Science Lab
          </a>
          ,{" "}
          <a href="https://ivia.ch/" target="_blank" rel="noreferrer">
            ETH Zurich
          </a>
          ,{" "}
          <a href="https://www.cg.tuwien.ac.at/" target="_blank" rel="noreferrer">
            TU Wien
          </a>
          , and the{" "}
          <a href="https://www.vis.uni-konstanz.de/" target="_blank" rel="noreferrer">
            University of Konstanz
          </a>
          .
        </p>
        <p>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub repository
          </a>
          {" · "}
          <a href=".">Launch {TOOL_NAME}</a>
        </p>
      </footer>
    </div>
  );
}
