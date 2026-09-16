import { fireEvent, render, screen } from "@testing-library/react";
import LandingPage, { INSTITUTIONS } from "./LandingPage";
import {
  FIGURE_CARDS,
  IRIS_ATTRIBUTION,
  IRIS_CSV_URL,
  IRIS_SECTION_ID,
  IRIS_TUTORIAL_STEPS,
  PAGE_TITLE_MAIN,
  PAGE_TITLE_SUB,
  allFigureLinks,
  redirectUrl,
} from "./landingContent";

describe("LandingPage", () => {
  // Rendered WITHOUT the Redux Provider on purpose: the landing must stay
  // mountable before the app boots (see src/index.tsx), so any accidental
  // useSelector/MUI dependency inside it should fail this suite.
  it("renders without the app providers", () => {
    render(<LandingPage />);
    // Hero splits the paper title: heading + subheading on its own line.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(PAGE_TITLE_MAIN);
    // Subtitle appears in the top bar and as the hero subheading.
    expect(screen.getAllByText(PAGE_TITLE_SUB).length).toBeGreaterThanOrEqual(2);
  });

  it("links the launch buttons and the teaser image to the bare URL", () => {
    render(<LandingPage />);
    const launchLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === ".");
    // top bar + hero + teaser image + footer
    expect(launchLinks.length).toBeGreaterThanOrEqual(3);
    const teaser = screen.getByAltText(/annotated projection/).closest("a");
    expect(teaser?.getAttribute("href")).toBe(".");
  });

  it("offers Figure demos and Video hero buttons", () => {
    render(<LandingPage />);
    expect(screen.getByText("Figure demos").getAttribute("href")).toBe("#/figures");
    // Both the nav entry and the hero button scroll to the Video section;
    // YouTube is reached from the link under the player instead.
    for (const a of screen.getAllByText("Video", { selector: "a" })) {
      expect(a.getAttribute("href")).toBe("#/video");
    }
    // The section shows our own poster until it is clicked, so no YouTube
    // resources and no player chrome load with the page.
    expect(screen.queryByTitle("Demo video")).toBeNull();
    const play = screen.getByLabelText("Play the demo video");
    fireEvent.click(play);
    expect(screen.getByTitle("Demo video").getAttribute("src")).toContain(
      "youtube-nocookie.com/embed/",
    );
    expect(
      screen.getByText("Watch on YouTube").getAttribute("href"),
    ).toBe(redirectUrl("video"));
  });

  it("renders one card per paper figure with all its demo links", () => {
    render(<LandingPage />);
    for (const card of FIGURE_CARDS) {
      expect(screen.getByText(card.description)).toBeTruthy();
      expect(screen.getByAltText(card.title).getAttribute("src")).toBe(card.image);
    }
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    // Cards link to the lab-website redirect permalinks (paper source of truth),
    // not the raw deep-link hashes, so they cannot drift out of date.
    for (const l of allFigureLinks()) {
      expect(hrefs).toContain(redirectUrl(l.slug));
    }
  });

  it("scrolls to the hash-named section on mount (direct #/python loads)", () => {
    const original = Element.prototype.scrollIntoView;
    const spy = jest.fn();
    Element.prototype.scrollIntoView = spy; // jsdom has no implementation
    window.location.hash = "#/python";
    try {
      render(<LandingPage />);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.contexts[0] as HTMLElement).id).toBe("/python");
    } finally {
      Element.prototype.scrollIntoView = original;
      window.location.hash = "";
    }
  });

  it("renders no em or en dashes (CS copy preference)", () => {
    const { container } = render(<LandingPage />);
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("shows every institution as a linked logo in the footer", () => {
    render(<LandingPage />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const org of INSTITUTIONS) {
      expect(hrefs).toContain(org.href);
      expect(screen.getByAltText(org.name).getAttribute("src")).toBe(org.logo);
    }
  });

  it("explains the on-demand Gymnasium render insets and their limitation", () => {
    render(<LandingPage />);
    expect(screen.getByText(/local render service/).textContent).toContain("Gymnasium");
    expect(screen.getByText(/local render service/).textContent).toContain("not on this hosted demo");
  });

  it("renders the iris walkthrough section with all steps", () => {
    const { container } = render(<LandingPage />);
    // Deep-linkable anchor (#/iris), same pattern as the other sections.
    expect(container.querySelector(`[id="${IRIS_SECTION_ID}"]`)).toBeTruthy();
    expect(screen.getByText("Upload data").getAttribute("href")).toBe(`#${IRIS_SECTION_ID}`);
    for (const step of IRIS_TUTORIAL_STEPS) {
      expect(screen.getByText(step.title)).toBeTruthy();
      if (step.image) {
        expect(screen.getByAltText(step.alt!).getAttribute("src")).toBe(step.image);
      }
    }
  });

  it("offers the iris.csv download with its attribution line", () => {
    render(<LandingPage />);
    const link = screen.getByText("Download iris.csv");
    expect(link.getAttribute("href")).toBe(IRIS_CSV_URL);
    expect(link.getAttribute("download")).toBe("iris.csv");
    expect(screen.getByText(IRIS_ATTRIBUTION)).toBeTruthy();
    // The licensing line must credit source and license verbatim.
    expect(IRIS_ATTRIBUTION).toContain("Fisher");
    expect(IRIS_ATTRIBUTION).toContain("UCI Machine Learning Repository");
    expect(IRIS_ATTRIBUTION).toContain("CC BY 4.0");
  });

  it("shows the pip install snippet and the GitHub link", () => {
    render(<LandingPage />);
    expect(screen.getByText(/pip install/).textContent).toContain("pip install");
    const github = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("https://github.com/"));
    expect(github.length).toBeGreaterThanOrEqual(1);
  });
});
