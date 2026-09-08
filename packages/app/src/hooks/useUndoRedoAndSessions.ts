import { useCallback, useEffect, useRef } from "react";
import { useDispatch } from "react-redux";
import { SessionPersistenceService, type LabelingSession } from "../services/SessionPersistenceService";
import {
    defaultUndoRedoStack,
    UndoRedoStack,
    type LabelingAction,
} from "../services/UndoRedoStack";
import {
    applyRedoAction,
    applyUndoAction,
    loadSessionFromStorage,
    setCurrentSessionId,
} from "../slices/labelingSlice";
import type { AppDispatch } from "../store";
import type { ClusterId } from "../types/labeling";

/**
 * Hook for managing undo/redo and session persistence.
 * Integrates with Redux and local storage.
 */
export const useUndoRedoAndSessions = () => {
  const dispatch = useDispatch<AppDispatch>();
  const undoRedoRef = useRef<UndoRedoStack>(defaultUndoRedoStack);
  const autosaveTimerRef = useRef<number | null>(null);

  /**
   * Undo the last labeling action
   */
  const handleUndo = useCallback(() => {
    const action = undoRedoRef.current.undo();
    if (!action) return;

    dispatch(applyUndoAction(action.previousState));
  }, [dispatch]);

  /**
   * Redo the last undone action
   */
  const handleRedo = useCallback(() => {
    const action = undoRedoRef.current.redo();
    if (!action) return;

    dispatch(applyRedoAction(action.newState));
  }, [dispatch]);

  // Enable keyboard shortcuts: Ctrl+Z (undo), Ctrl+Shift+Z (redo).
  // Both handlers are dispatch-stable useCallbacks, so this re-subscribes
  // only if the store identity ever changed (i.e. never in practice).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  /**
   * Check if undo is available
   */
  const canUndo = useCallback(
    () => undoRedoRef.current.canUndo(),
    []
  );

  /**
   * Check if redo is available
   */
  const canRedo = useCallback(
    () => undoRedoRef.current.canRedo(),
    []
  );

  /**
   * Clear undo/redo history (on reset or session load)
   */
  const clearHistory = useCallback(() => {
    undoRedoRef.current.clear();
  }, []);

  /**
   * Record an action for undo/redo tracking
   */
  const recordAction = useCallback((action: LabelingAction) => {
    undoRedoRef.current.recordAction(action);
  }, []);

  /**
   * Save current labels as a named session
   */
  const saveSession = useCallback(
    (
      assignments: Map<ClusterId, string>,
      datasetKey: string,
      datasetName: string,
      clusterCount: number,
      sessionName?: string
    ) => {
      const labels: Record<string, string> = {};
      assignments.forEach((label, id) => {
        labels[id] = label;
      });

      const session = SessionPersistenceService.createSession(
        datasetKey,
        datasetName,
        labels,
        clusterCount,
        sessionName,
        false // not autosave
      );

      dispatch(setCurrentSessionId(session.id));
      return session;
    },
    [dispatch]
  );

  /**
   * Load a session from storage
   */
  const loadSession = useCallback(
    (sessionId: string) => {
      const session = SessionPersistenceService.getSession(sessionId);
      if (!session) return false;

      dispatch(
        loadSessionFromStorage({
          labels: session.labels,
          sessionId: session.id,
          sessionName: session.name,
        })
      );

      clearHistory();
      return true;
    },
    [dispatch, clearHistory]
  );

  /**
   * Autosave the current state
   */
  const autosave = useCallback(
    (
      assignments: Map<ClusterId, string>,
      datasetKey: string,
      datasetName: string,
      clusterCount: number,
      currentSessionId?: string
    ) => {
      const labels: Record<string, string> = {};
      assignments.forEach((label, id) => {
        labels[id] = label;
      });

      // Update existing session if we have one, otherwise create autosave
      if (currentSessionId) {
        const existing = SessionPersistenceService.getSession(currentSessionId);
        if (existing) {
          existing.labels = labels;
          existing.modifiedAt = Date.now();
          SessionPersistenceService.saveSession(existing);
          return;
        }
      }

      SessionPersistenceService.createSession(
        datasetKey,
        datasetName,
        labels,
        clusterCount,
        `Autosave ${new Date().toLocaleTimeString()}`,
        true // is autosave
      );
    },
    []
  );

  /**
   * Enable autosave with specified interval (ms)
   */
  const enableAutosave = useCallback(
    (
      assignments: Map<ClusterId, string>,
      datasetKey: string,
      datasetName: string,
      clusterCount: number,
      intervalMs: number = 30000 // Default: 30 seconds
    ) => {
      // Clear existing timer
      if (autosaveTimerRef.current) {
        clearInterval(autosaveTimerRef.current);
      }

      // Set up new autosave timer
      const currentSessionId = SessionPersistenceService.getSessionsByDataset(
        datasetKey
      )[0]?.id;

      autosaveTimerRef.current = window.setInterval(() => {
        autosave(assignments, datasetKey, datasetName, clusterCount, currentSessionId);
      }, intervalMs);

      return () => {
        if (autosaveTimerRef.current) {
          clearInterval(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
      };
    },
    [autosave]
  );

  /**
   * Disable autosave
   */
  const disableAutosave = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearInterval(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  /**
   * Get recent sessions
   */
  const getRecentSessions = useCallback(
    (datasetKey: string, limit = 10): LabelingSession[] => {
      const sessions = SessionPersistenceService
        .getSessionsByDataset(datasetKey)
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      return sessions.slice(0, limit);
    },
    []
  );

  /**
   * Delete a session
   */
  const deleteSession = useCallback((sessionId: string) => {
    SessionPersistenceService.deleteSession(sessionId);
  }, []);

  /**
   * Get storage usage stats
   */
  const getStorageStats = useCallback(
    () => SessionPersistenceService.getStorageStats(),
    []
  );

  return {
    // Undo/Redo
    undo: handleUndo,
    redo: handleRedo,
    canUndo,
    canRedo,
    clearHistory,
    recordAction,

    // Sessions
    saveSession,
    loadSession,
    getRecentSessions,
    deleteSession,

    // Autosave
    autosave,
    enableAutosave,
    disableAutosave,

    // Stats
    getStorageStats,
  };
};
