
export type ColorEncoding = string;

export type RendererVisualSettings = {
  /** Node point size in CSS px (scaled by DPR in the renderer). */
  nodeRadius: number;

  /** Optional node circle outline width in CSS px (scaled by DPR in the renderer). */
  nodeOutlineWidth: number;

  /** When true, node outlines are drawn white instead of the default black. */
  nodeOutlineWhite: boolean;

  /** Edge thickness in CSS px (scaled by DPR in the renderer). */
  edgeWidth: number;

  /** Arrow length scale in CSS px (scaled by DPR in the renderer). */
  arrowScale: number;

  /** Palette used to build the internal color scale. */
  colorPalette: string[];

  /** Key for selecting how colors are derived from data. */
  colorEncoding: ColorEncoding;

  /** DOI threshold used by shaders for gray-out / opacity behavior. */
  grayOutDoiThreshold: number;

  /** DOI threshold used for label visibility and DOI color anchoring. */
  annotationDoiThreshold: number;

  /** DOI threshold used for inset visibility and DOI color anchoring. */
  insetDoiThreshold: number;

  /** Opacity clamp (min). */
  minimumOpacityClamping: number;

  /** Opacity clamp (max). */
  maximumOpacityClamping: number;

  /** Optional canvas background color. */
  canvasBgColor?: string;
};

export type OpacityParams = {
  threshold: number;
  minAlpha: number;
  maxAlpha: number;
  /** When true, forces gray-below-threshold regardless of colorEncoding (used by spotlight). */
  forceApplyGray?: boolean;
};

export type OpacityFieldUpdateMode = "full" | "preview";

export type StyleSettings = Pick<RendererVisualSettings, "nodeRadius" | "nodeOutlineWidth" | "edgeWidth" | "arrowScale">;

export type ColorMapping = Pick<RendererVisualSettings, "colorPalette" | "colorEncoding">;
