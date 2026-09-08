/**
 * Static content for the landing page (`#/`). Kept separate from
 * `LandingPage.tsx` so the data is unit-testable and the component file only
 * exports a component (react-refresh rule).
 *
 * The cards link to the lab-website redirect permalinks (`redirectUrl(slug)`),
 * the SAME `\figliveat{<slug>}` targets the paper prints. Those redirect files
 * (`jku-vds-lab.github.io/redirects/steinparz/tvcg26/tvcg26-steinparz-<slug>.md`)
 * are the single source of truth for each figure state, so the landing links
 * cannot drift out of date when a figure's deep link is retuned.
 *
 * Each link also keeps a `hash` mirroring its redirect target verbatim. It is
 * not used for the href; it exists only so the unit test can prove every figure
 * state still decodes with the real deep-link codec (the test cannot fetch the
 * remote redirect). The card images are downscaled copies of the paper figures
 * (public/landing/figures/).
 */

/** Paper title, split so the hero can render heading + subheading. */
export const PAGE_TITLE_MAIN = "Details Where They Matter";
export const PAGE_TITLE_SUB =
  "Understanding Projection Spaces Using In-Place Summary Visualizations";

/** Full paper title (as printed on the paper). */
export const PAGE_TITLE = `${PAGE_TITLE_MAIN}: ${PAGE_TITLE_SUB}`;

/** Deployed app name; keep in sync with `site.config.json` (JSON imports are off in tsconfig). */
export const TOOL_NAME = "Adaptive Detail Views";

/** Lab-website base that hosts the `\figliveat{<slug>}` redirects. */
const REDIRECT_BASE = "https://jku-vds-lab.github.io";

/**
 * Redirect permalink for a figure slug, e.g.
 * `https://jku-vds-lab.github.io/tvcg26-steinparz-rubiks-overview/`. This is the
 * same target the paper links to; the redirect file forwards it into the tool.
 */
export function redirectUrl(slug: string): string {
  return `${REDIRECT_BASE}/tvcg26-steinparz-${slug}/`;
}

export interface FigureDemoLink {
  /** Paper redirect slug, e.g. "rubiks-overview". */
  slug: string;
  /** Short pill label on the card. */
  label: string;
  /** Deep-link hash the redirect forwards to; kept for the codec test only. */
  hash: string;
}

export interface FigureCard {
  /** Figure id — also the thumbnail basename under landing/figures/. */
  id: string;
  title: string;
  /** Relative thumbnail URL (downscaled paper figure). */
  image: string;
  /** One-sentence description derived from the figure caption. */
  description: string;
  links: readonly FigureDemoLink[];
}

export const FIGURE_CARDS: readonly FigureCard[] = [
  {
    id: "teaser",
    title: "Adaptive detail in place",
    image: "landing/figures/teaser.jpg",
    description:
      "Projections of Rubik's cube solution trajectories are annotated like a map with contours, text labels, and summary insets, and zooming refines the detail in place.",
    links: [
      { slug: "rubiks-overview", label: "Annotated overview", hash: "#v=1&ds=rubik10" },
      { slug: "rubiks-loop", label: "Zoom into the loop", hash: "#v=1&ds=rubik10&c.maxActiveClusters=4&c.relationInsetBudget=4&q=phase%3D%22solving+white+cross%22&vb=-49.3666%2C18.6133%2C-63.3618%2C-21.7731&demo=sel,fly,params&spot=1" },
    ],
  },
  {
    id: "scenario-subclusters",
    title: "Subcluster structure in MNIST",
    image: "landing/figures/scenario-subclusters.jpg",
    description:
      "Zooming resolves the 2s into subclusters with and without the lower-left loop, the 1s into upright and antidiagonal strokes, and exposes 7s hiding among the diagonal 1s.",
    links: [
      { slug: "mnist-overview", label: "Overview", hash: "#v=1&ds=mnist" },
      { slug: "mnist-subclusters", label: "Split 2s & 1s", hash: "#v=1&ds=mnist&vb=4.83094%2C20.1891%2C-4.65171%2C4.92535&demo=1&spot=1" },
      { slug: "mnist-sevens", label: "7s among 1s", hash: "#v=1&ds=mnist&vb=16.2701%2C16.479%2C0.811223%2C0.941493&demo=1&spot=1" },
    ],
  },
  {
    id: "scenario-propagation",
    title: "Steering interest along trajectories",
    image: "landing/figures/scenario-propagation.jpg",
    description:
      "The query age<0.05 emphasizes only the starting states; dragging the forward-propagation slider extends the emphasis along each trajectory's forward direction, live.",
    links: [
      { slug: "rubiks-starts", label: "Query: starts", hash: "#v=1&ds=rubik10&s.proximitySlider=0&s.pastSlider=0&s.futureSlider=0&q=age<0.05&demo=sel,params&spot=1" },
      { slug: "rubiks-forward", label: "Forward propagation", hash: "#v=1&ds=rubik10&s.proximitySlider=0&s.pastSlider=0&s.futureSlider=0.837021&q=age%3C0.05&demo=sel,params&spot=1" },
    ],
  },
  {
    id: "scenario-diff",
    title: "Reading trajectories through difference insets",
    image: "landing/figures/scenario-diff.jpg",
    description:
      "Difference insets on large transitions show the applied rotation; a looping bundle decodes as the repeated corner-solving sequence R U R' U'.",
    links: [
      { slug: "rubiks-trajectory", label: "Single trajectory", hash: "#v=1&ds=rubik10&c.relationInsetBudget=6&c.gapDisclosurePx=0&q=line%3D15&vb=-46.964%2C29.4172%2C-17.7021%2C29.9279&demo=sel,fly&spot=1" },
      { slug: "rubiks-loop", label: "Looping bundle", hash: "#v=1&ds=rubik10&c.maxActiveClusters=4&c.relationInsetBudget=4&q=phase%3D%22solving+white+cross%22&vb=-49.3666%2C18.6133%2C-63.3618%2C-21.7731&demo=sel,fly,params&spot=1" },
    ],
  },
  {
    id: "scenario-hover",
    title: "Comparing clusters on hover",
    image: "landing/figures/scenario-hover.jpg",
    description:
      "Hovering an inset creates difference views against every other active cluster. The blue corner region marks a jacket hanging from the door in the other clusters.",
    links: [{ slug: "cctv-hover", label: "Hover comparison", hash: "#v=1&ds=cctv&c.splitThresholdFraction=0.033&sel=1qa.3.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.ei.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1&vb=-1.88482%2C2.17801%2C-3.83005%2C-1.29654&demo=sel,fly&spot=1" }],
  },
  {
    id: "scenario-labeling",
    title: "Labeling with difference insets",
    image: "landing/figures/scenario-labeling.jpg",
    description:
      "Two similar-looking subclusters differ in a difference inset exactly where the monitor sits: between the two groups of frames it has turned itself off.",
    links: [
      { slug: "cctv-monitor-off", label: "Monitor turns off", hash: "#v=1&ds=cctv&c.relationInsetBudget=1&vb=0.780371%2C1.6577%2C0.525235%2C1.0763&demo=fly,params&spot=1" },
    ],
  },
  {
    id: "evaluation-cctv",
    title: "CCTV data, annotated automatically",
    image: "landing/figures/evaluation-cctv.jpg",
    description:
      "The Edinburgh office CCTV projection annotated without user intervention, next to a manually annotated Time Curves view; a selection reveals trajectory details.",
    links: [
      { slug: "cctv-overview", label: "Annotated projection", hash: "#v=1&ds=cctv" },
      { slug: "cctv-light-on", label: "Trajectory selection", hash: "#v=1&ds=cctv&s.futureSlider=1&sel=18m.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1&vb=-2.6501%2C5.65781%2C-3.65249%2C1.52818&demo=1&spot=1" },
    ],
  },
  {
    id: "evaluation-chess",
    title: "Chess openings, one selection",
    image: "landing/figures/evaluation-chess.jpg",
    description:
      "A single selection with backward propagation annotates a recurring opening in place: summary insets show the positions, difference insets the moves between them.",
    links: [{ slug: "chess-opening", label: "Opening sequence", hash: "#v=1&ds=chess40k&s.pastSlider=0.861136&s.futureSlider=0&c.relationInsetBudget=3&sel=xf.a8.5p.bt.1mm.1uf.9h.6a.40.263.cz4.13o.16u.h0.wp.gc.lv.1lf.b3.7g.ca.6w.39.os.108&vb=26.9356%2C33.2449%2C-11.3608%2C-7.39776&demo=fly,sel,params&spot=1" }],
  },
  {
    id: "evaluation-fashion",
    title: "Fashion-MNIST, task by task",
    image: "landing/figures/evaluation-fashion.jpg",
    description:
      "The opening view already annotates the salient clusters; zooming splits the shoe region into its classes and surfaces the flip-flop flare as a subcluster inset.",
    links: [
      { slug: "fashion-overview", label: "Overview", hash: "#v=1&ds=fashion&demo=1&spot=1" },
      { slug: "fashion-shoes", label: "Shoe region", hash: "#v=1&ds=fashion&vb=6.7713%2C21.6078%2C-1.4396%2C7.87945&demo=1&spot=1" },
      { slug: "fashion-flipflops", label: "Flip-flops", hash: "#v=1&ds=fashion&vb=10.1393%2C13.367%2C0.0809162%2C2.10828&demo=1&spot=1" },
    ],
  },
];

/** All demo links across cards (a slug may appear on more than one card). */
export function allFigureLinks(): FigureDemoLink[] {
  return FIGURE_CARDS.flatMap((c) => [...c.links]);
}

// ---------------------------------------------------------------------------
// "Try it with your own data" walkthrough (Iris)
// ---------------------------------------------------------------------------

/** Anchor id of the walkthrough section; deep-linked as `#/iris`. */
export const IRIS_SECTION_ID = "/iris";

/** Hosted sample CSV (relative to the app base, like the landing images). */
export const IRIS_CSV_URL = "landing/iris.csv";

/** One-line source attribution shown next to the download link. */
export const IRIS_ATTRIBUTION =
  "Iris dataset: R. A. Fisher (1936), via the UCI Machine Learning Repository (CC BY 4.0).";

export interface IrisTutorialStep {
  title: string;
  /** Reviewer-facing instruction; names only UI elements visible on screen. */
  text: string;
  /** Screenshot under landing/iris/ (step 1 is the download itself, no image). */
  image?: string;
  alt?: string;
  /** Intrinsic image size in CSS px: reserves the aspect ratio before the
   *  image loads and caps cropped shots at their natural width. */
  imageWidth?: number;
  imageHeight?: number;
}

export const IRIS_TUTORIAL_STEPS: readonly IrisTutorialStep[] = [
  {
    title: "Download the sample data",
    text:
      "iris.csv is a plain table of 150 flowers: four size measurements and the variety of " +
      "each flower. Any CSV of your own works the same way, as long as it has numeric columns.",
  },
  {
    title: "Drop the file into the app",
    text:
      "Launch the application, select the Dataset tab on the left, and drag iris.csv onto " +
      "the Custom datasets field (or pick the file via Browse).",
    image: "landing/iris/step-drop.jpg",
    alt: "The Dataset tab with the Custom datasets drop zone at the top of the side panel",
    imageWidth: 500,
    imageHeight: 460,
  },
  {
    title: "Tell the app what the columns mean",
    text:
      "A dialog asks which columns to use. Choose sepal_length as the X column and " +
      "sepal_width as the Y column. These two measurements become the starting positions " +
      "of the points. The variety column is picked up as the class label automatically. " +
      "Click Load.",
    image: "landing/iris/step-wizard.jpg",
    alt: "The Load CSV dataset dialog with sepal_length as X column, sepal_width as Y column, and variety as class label",
    imageWidth: 540,
    imageHeight: 660,
  },
  {
    title: "Compute a projection",
    text:
      "Open the Projection tab. Under Features to project, keep only the four measurement " +
      "columns and deselect variety and label, so the layout is computed without knowing " +
      "the answer. Click Run projection. UMAP places similar flowers next to each other, " +
      "and the app clusters and annotates the new layout on its own.",
    image: "landing/iris/step-projection.jpg",
    alt: "The Projection tab after running UMAP, with the reprojected iris points forming clusters annotated with summary insets",
    imageWidth: 1440,
    imageHeight: 900,
  },
  {
    title: "Color the points by variety",
    text:
      "Open the Vis Encoding tab and set Color feature to variety. Each variety gets its " +
      "own color, showing how well the measurement-based layout separates the three " +
      "varieties.",
    image: "landing/iris/step-color.jpg",
    alt: "The Vis Encoding tab with variety as the color feature, coloring the three iris varieties in the projection",
    imageWidth: 1440,
    imageHeight: 900,
  },
];
