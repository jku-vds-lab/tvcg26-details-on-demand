// visTypes.ts
import * as d3 from "d3";

/**
 * A type alias for a D3 selection of an SVG element.
 * Note: Using SVGSVGElement (instead of the more generic SVGElement) provides stronger typing for SVG-specific APIs.
 */
export type SVGSelection = d3.Selection<SVGSVGElement, unknown, null, undefined>;
