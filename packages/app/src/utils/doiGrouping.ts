import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";

/**
 * Assigns a doiGroup to each node based on its DoI value and the given thresholds.
 * The groups are:
 * - "gray": DoI < grayOutDoiThreshold
 * - "transparent": grayOutDoiThreshold <= DoI < annotationDoiThreshold
 * - "annotation": annotationDoiThreshold <= DoI < insetDoiThreshold
 * - "inset": DoI >= insetDoiThreshold
 *
 * This function mutates the node objects.
 */
export function groupNodesByDoiThreshold(
  nodes: DataPoint[],
  thresholds: {
    grayOutDoiThreshold: number;
    annotationDoiThreshold: number;
    insetDoiThreshold: number;
  }
): void {
  const { grayOutDoiThreshold, annotationDoiThreshold, insetDoiThreshold } = thresholds;
    for (const node of nodes) {
        if (node.DoI < grayOutDoiThreshold) {
            node.doiGroup = "gray";
        } else if (node.DoI < annotationDoiThreshold) {
            node.doiGroup = "transparent";
        } else if (node.DoI < insetDoiThreshold) {
            node.doiGroup = "annotation";
        } else {
            node.doiGroup = "inset";
        }
    }
}
