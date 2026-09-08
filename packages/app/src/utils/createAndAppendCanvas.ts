
/**
 * Helper function that creates a canvas element within the given container.
 * It computes the container's width and height, sets the canvas dimensions,
 * applies proper styling, appends the canvas to the container, and returns it.
 *
 * @param container - The HTMLDivElement to which the canvas is appended.
 * @returns The created HTMLCanvasElement.
 */
export const createAndAppendCanvas = (container: HTMLDivElement): HTMLCanvasElement => {
  // Get container dimensions.
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  // Create canvas element.
  const canvas = document.createElement("canvas");
  canvas.width = containerWidth;
  canvas.height = containerHeight;
  // Set style to fill container.
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.backgroundColor = container.style.backgroundColor || "#ffffff";
  // Append the canvas to the container.
  container.appendChild(canvas);
  return canvas;
};
