import type { SemanticLabel, ValidationResult } from "../types/labeling";
import { createSemanticLabel } from "../types/labeling";

/**
 * Business logic and validation for the labeling system.
 * Testable, independent of React/Redux.
 */
export class LabelingService {
  /**
   * Validate a label string
   */
  static validateLabel(label: string): ValidationResult {
    const trimmed = label.trim();

    if (!trimmed) {
      return { valid: false, error: "Label cannot be empty" };
    }

    return { valid: true };
  }

  /**
   * Normalize a label by trimming surrounding whitespace.
   */
  static normalizeLabel(label: string): SemanticLabel {
    return createSemanticLabel(label.trim());
  }
}
