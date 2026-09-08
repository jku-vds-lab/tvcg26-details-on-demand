/**
 * Labeling sessions persistence & backup system.
 * Handles saving/loading/versioning of labeling work with data snapshots.
 */

import type { LabelingExport } from "../types/labeling";

/** A complete labeling session snapshot */
export interface LabelingSession {
  id: string; // UUID or timestamp
  name: string; // User-friendly session name
  datasetKey: string;
  datasetName: string;
  createdAt: number;
  modifiedAt: number;
  labels: Record<string, string>; // clusterId → label
  /** Snapshot of original cluster count (for reference) */
  clusterCount: number;
  /** Notes about this session */
  notes?: string;
  /** Whether this is autosaved or manual save */
  isAutosave: boolean;
}

/** Backup system: keeps original data + labeled versions */
export interface DatasetSnapshot {
  /** Stable key for dataset identity */
  datasetKey: string;
  /** Original unmodified dataset name */
  datasetName: string;
  /** When snapshot was created */
  createdAt: number;
  /** Original cluster count */
  clusterCount: number;
  /** Original cluster metadata (if available) */
  originalClusterData?: Record<string, unknown>;
  /** All labeling sessions for this dataset */
  sessions: LabelingSession[];
}

const STORAGE_KEY_PREFIX = "labeling_";
const STORAGE_KEY_SESSIONS = "labeling_sessions";
const STORAGE_KEY_SNAPSHOTS = "labeling_snapshots";

/**
 * Session persistence service.
 * Uses localStorage for quick access; can extend to IndexedDB for large datasets.
 */
export class SessionPersistenceService {
  /**
   * Save a labeling session to localStorage
   */
  static saveSession(session: LabelingSession): void {
    try {
      const sessions = this.getAllSessions();
      const existingIdx = sessions.findIndex((s) => s.id === session.id);
      if (existingIdx >= 0) {
        sessions[existingIdx] = session;
      } else {
        sessions.push(session);
      }
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }

  /**
   * Create a new session and save it
   */
  static createSession(
    datasetKey: string,
    datasetName: string,
    labels: Record<string, string>,
    clusterCount: number,
    name?: string,
    isAutosave = false
  ): LabelingSession {
    const session: LabelingSession = {
      id: isAutosave ? `autosave_${Date.now()}` : `session_${Date.now()}`,
      name: name || `Labeling ${new Date().toLocaleString()}`,
      datasetKey,
      datasetName,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      labels,
      clusterCount,
      isAutosave,
    };
    this.saveSession(session);
    return session;
  }

  /**
   * Get all sessions for a dataset
   */
  static getSessionsByDataset(datasetKey: string): LabelingSession[] {
    return this.getAllSessions().filter((s) => s.datasetKey === datasetKey);
  }

  /**
   * Get all sessions (across all datasets)
   */
  static getAllSessions(): LabelingSession[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_SESSIONS);
      return data ? JSON.parse(data) : [];
    } catch (err) {
      console.error("Failed to load sessions:", err);
      return [];
    }
  }

  /**
   * Get a specific session by ID
   */
  static getSession(sessionId: string): LabelingSession | null {
    const sessions = this.getAllSessions();
    return sessions.find((s) => s.id === sessionId) ?? null;
  }

  /**
   * Delete a session
   */
  static deleteSession(sessionId: string): void {
    try {
      const sessions = this.getAllSessions().filter((s) => s.id !== sessionId);
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }

  /**
   * Delete all autosave sessions older than X minutes
   */
  static cleanupOldAutosaves(maxAgeMinutes = 60): void {
    try {
      const now = Date.now();
      const maxAge = maxAgeMinutes * 60 * 1000;
      const sessions = this
        .getAllSessions()
        .filter((s) => !(s.isAutosave && now - s.modifiedAt > maxAge));
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    } catch (err) {
      console.error("Failed to cleanup autosaves:", err);
    }
  }

  /**
   * Export session as JSON for sharing/archiving
   */
  static exportSession(sessionId: string): LabelingExport | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    return {
      version: "1.0",
      datasetName: session.datasetName,
      labelField: "label",
      exportedAt: new Date().toISOString(),
      totalClusters: session.clusterCount,
      totalLabeled: Object.keys(session.labels).length,
      labels: session.labels,
    };
  }

  /**
   * Create a snapshot of original dataset (for backup/reference)
   */
  static createSnapshot(
    datasetKey: string,
    datasetName: string,
    clusterCount: number,
    originalData?: Record<string, unknown>
  ): DatasetSnapshot {
    const snapshot: DatasetSnapshot = {
      datasetKey,
      datasetName,
      createdAt: Date.now(),
      clusterCount,
      originalClusterData: originalData,
      sessions: this.getSessionsByDataset(datasetKey),
    };

    try {
      const snapshots = this.getAllSnapshots();
      snapshots.push(snapshot);
      localStorage.setItem(STORAGE_KEY_SNAPSHOTS, JSON.stringify(snapshots));
    } catch (err) {
      console.error("Failed to save snapshot:", err);
    }

    return snapshot;
  }

  /**
   * Get all snapshots
   */
  static getAllSnapshots(): DatasetSnapshot[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY_SNAPSHOTS);
      return data ? JSON.parse(data) : [];
    } catch (err) {
      console.error("Failed to load snapshots:", err);
      return [];
    }
  }

  /**
   * Get snapshot for a dataset
   */
  static getSnapshotByDataset(datasetKey: string): DatasetSnapshot | null {
    const snapshots = this.getAllSnapshots();
    return snapshots.find((s) => s.datasetKey === datasetKey) ?? null;
  }

  /**
   * Check available storage space (approximate)
   */
  static getStorageStats(): { used: number; available: number } {
    try {
      let used = 0;
      for (const key in localStorage) {
        if (key.startsWith(STORAGE_KEY_PREFIX)) {
          used += localStorage.getItem(key)?.length ?? 0;
        }
      }
      // LocalStorage is typically 5-10MB per origin
      const available = 10 * 1024 * 1024; // 10MB estimate
      return { used, available };
    } catch {
      return { used: 0, available: 0 };
    }
  }
}
