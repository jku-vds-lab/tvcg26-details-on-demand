/**
 * Undo/Redo functionality for labeling operations.
 * Maintains a history of labeling actions that can be reverted/reapplied.
 */

import type { ClusterId, SemanticLabel } from "../types/labeling";

/** A single undoable labeling action */
export interface LabelingAction {
  /** Unique action ID */
  id: string;
  /** Type of action */
  type: "assign" | "remove" | "select" | "bulk";
  /** Timestamp when action was performed */
  timestamp: number;
  /** Affected cluster IDs */
  clusterIds: ClusterId[];
  /** Label value (if applicable) */
  label?: SemanticLabel;
  /** Previous state (for undo) */
  previousState: Record<string, string | null>; // clusterId → label | null
  /** New state (for redo) */
  newState: Record<string, string | null>;
  /** Human-readable description */
  description: string;
}

/**
 * Undo/Redo stack manager
 * Tracks labeling history and allows reverting/reapplying actions.
 */
export class UndoRedoStack {
  private undoStack: LabelingAction[] = [];
  private redoStack: LabelingAction[] = [];
  private listeners: Set<() => void> = new Set();
  private maxStackSize = 50; // Prevent memory bloat

  /**
   * Record an action in the undo stack
   */
  recordAction(action: LabelingAction): void {
    // Adding new action clears redo stack
    this.redoStack = [];

    // Limit stack size
    if (this.undoStack.length >= this.maxStackSize) {
      this.undoStack.shift();
    }

    this.undoStack.push(action);
    this.notifyListeners();
  }

  /**
   * Create and record an "assign label" action
   */
  recordAssignAction(
    clusterIds: ClusterId[],
    label: SemanticLabel,
    previousAssignments: Record<string, SemanticLabel | undefined>
  ): void {
    const previousState: Record<string, string | null> = {};
    const newState: Record<string, string> = {};

    clusterIds.forEach((id) => {
      previousState[id] = previousAssignments[id] ?? null;
      newState[id] = label;
    });

    const action: LabelingAction = {
      id: `action_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: "assign",
      timestamp: Date.now(),
      clusterIds,
      label,
      previousState,
      newState: newState as Record<string, string | null>,
      description: `Assigned "${label}" to ${clusterIds.length} cluster${clusterIds.length !== 1 ? "s" : ""}`,
    };

    this.recordAction(action);
  }

  /**
   * Create and record a "remove label" action
   */
  recordRemoveAction(
    clusterIds: ClusterId[],
    previousAssignments: Record<string, SemanticLabel>
  ): void {
    const previousState: Record<string, string> = {};
    const newState: Record<string, null> = {};

    clusterIds.forEach((id) => {
      previousState[id] = previousAssignments[id];
      newState[id] = null;
    });

    const action: LabelingAction = {
      id: `action_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: "remove",
      timestamp: Date.now(),
      clusterIds,
      previousState,
      newState: newState as Record<string, string | null>,
      description: `Removed labels from ${clusterIds.length} cluster${clusterIds.length !== 1 ? "s" : ""}`,
    };

    this.recordAction(action);
  }

  /**
   * Undo the last action
   */
  undo(): LabelingAction | null {
    if (this.undoStack.length === 0) return null;

    const action = this.undoStack.pop()!;
    this.redoStack.push(action);
    this.notifyListeners();
    return action;
  }

  /**
   * Redo the last undone action
   */
  redo(): LabelingAction | null {
    if (this.redoStack.length === 0) return null;

    const action = this.redoStack.pop()!;
    this.undoStack.push(action);
    this.notifyListeners();
    return action;
  }

  /**
   * Check if undo is available
   */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available
   */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Get the action that would be undone
   */
  peekUndo(): LabelingAction | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  /**
   * Get the action that would be redone
   */
  peekRedo(): LabelingAction | null {
    return this.redoStack[this.redoStack.length - 1] ?? null;
  }

  /**
   * Get full history (for debugging/inspection)
   */
  getHistory(): LabelingAction[] {
    return [...this.undoStack];
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.notifyListeners();
  }

  /**
   * Subscribe to changes
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Get current stack sizes (for stats)
   */
  getStackSizes(): { undo: number; redo: number } {
    return {
      undo: this.undoStack.length,
      redo: this.redoStack.length,
    };
  }
}

// Singleton instance
export const defaultUndoRedoStack = new UndoRedoStack();
