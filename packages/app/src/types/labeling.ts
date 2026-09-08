/**
 * Core types for the interactive labeling system.
 * Used for development & annotation workflows on trajectory clusters.
 */

/** Unique identifier for a cluster (typically the cluster index or ID) */
export type ClusterId = string & { readonly __brand: "ClusterId" };

/** Human-readable semantic label for a cluster */
export type SemanticLabel = string & { readonly __brand: "SemanticLabel" };

/** Branding helpers */
export const createClusterId = (id: string): ClusterId => id as ClusterId;
export const createSemanticLabel = (label: string): SemanticLabel => label as SemanticLabel;

/** Single label assignment with metadata */
export interface LabelAssignment {
  clusterId: ClusterId;
  label: SemanticLabel;
  assignedAt: number; // timestamp
  assignedBy?: string; // optional user identifier
}

/** Labeling mode state */
export interface LabelingState {
  /** Whether labeling mode is active */
  isEnabled: boolean;
  /** When true, already-labeled nodes are excluded from the DoI pipeline */
  unlabeledOnlyMode: boolean;
  /** Currently selected cluster IDs */
  selectedIds: Set<ClusterId>;
  /** Map of cluster ID → label */
  assignments: Map<ClusterId, SemanticLabel>;
  /** Input field value (while user is typing) */
  inputLabel: string;
  /** Error message (if validation failed) */
  inputError?: string;
  /** All labels in use (for autocomplete) */
  existingLabels: Set<SemanticLabel>;
  /**
   * Total number of labelable clusters. The ids themselves live in the lazy
   * registry (`labelingClusterIds.ts`) — never in Redux (issue #315 I2).
   */
  totalClusters: number;
  /** Metadata about the current labeling session */
  metadata: LabelingMetadata;
  /** UID of the cluster currently being edited via click-to-label (null = none) */
  activeInlineClusterUid: string | null;
  /** Element ID (for position lookup) of the cluster being edited */
  activeInlineElementId: string | null;
  /** Draft label text being typed into the inline input */
  activeInlineDraft: string;
}

/** Metadata about a labeling session */
export interface LabelingMetadata {
  /** Stable key for the currently loaded dataset (used for session partitioning) */
  datasetKey: string;
  /** Name of the dataset being labeled (e.g., "CCTV", "Chess") */
  datasetName: string;
  /** When labeling session started */
  startedAt: number;
  /** When last save occurred */
  lastSavedAt?: number;
  /** Notes or description */
  description?: string;
  /** Current session ID (if loaded from storage) */
  currentSessionId?: string;
  /** Whether autosave is enabled */
  autosaveEnabled: boolean;
}

/** Export format for saved labels */
export interface LabelingExport {
  version: "1.0";
  datasetName: string;
  labelField: string;
  exportedAt: string;
  totalClusters: number;
  totalLabeled: number;
  labels: Record<string, string>; // clusterId -> label
}

/** Progress summary */
export interface LabelingProgress {
  labeled: number;
  total: number;
  percentage: number;
}

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}
