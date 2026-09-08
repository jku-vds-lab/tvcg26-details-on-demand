import { findDatasetEntryBySlug } from "../datasets/catalog";
import { decodeDeepLink } from "../utils/deepLink";
import { resolveBootTarget } from "./bootTarget";
import { FIGURE_CARDS, allFigureLinks } from "./landingContent";

describe("FIGURE_CARDS", () => {
  it("covers the paper's linked figures", () => {
    expect(FIGURE_CARDS).toHaveLength(9);
    // A slug may appear on more than one card (rubiks-loop), but every card id
    // and its thumbnail basename are unique.
    expect(new Set(FIGURE_CARDS.map((c) => c.id)).size).toBe(FIGURE_CARDS.length);
    expect(new Set(allFigureLinks().map((l) => l.slug)).size).toBe(16);
  });

  it("names thumbnails after the card id", () => {
    for (const c of FIGURE_CARDS) {
      expect(c.image).toBe(`landing/figures/${c.id}.jpg`);
      expect(c.links.length).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(allFigureLinks().map((l) => [l.slug, l] as const))(
    "%s decodes with the real deep-link codec",
    (_slug, l) => {
      const decoded = decodeDeepLink(l.hash);
      expect(decoded).not.toBeNull();
      expect(decoded?.datasetSlug).toBeDefined();
      expect(findDatasetEntryBySlug(decoded!.datasetSlug!)).toBeDefined();
      // Clicking a demo link must boot the tool, not the landing.
      expect(resolveBootTarget(l.hash)).toBe("app");
    }
  );
});
