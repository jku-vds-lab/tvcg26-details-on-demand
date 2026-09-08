type LoadStatus = "completed" | "failed" | "cancelled";

interface StallSample {
  atMs: number;
  stallMs: number;
  phase: string;
}

interface LongTaskSample {
  atMs: number;
  durationMs: number;
  phase: string;
}

interface DatasetLoadReport {
  taskId: string;
  datasetPath: string;
  startedAtMs: number;
  endedAtMs: number;
  totalMs: number;
  status: LoadStatus;
  phaseAtEnd: string;
  maxStallMs: number;
  maxStallPhase: string;
  stallCount: number;
  topStalls: StallSample[];
  longTaskCount: number;
  maxLongTaskMs: number;
  maxLongTaskPhase: string;
  topLongTasks: LongTaskSample[];
}

export interface DatasetLoadMonitorHandle {
  setPhase: (phase: string) => void;
  stop: (status: LoadStatus) => DatasetLoadReport;
}

const CHECK_INTERVAL_MS = 50;
const STALL_THRESHOLD_MS = 120;
const TOP_N = 5;

const hasWindow = typeof window !== "undefined";

let activeMonitor: DatasetLoadMonitor | null = null;

function takeTopBy<T>(items: T[], getValue: (item: T) => number): T[] {
  return [...items].sort((a, b) => getValue(b) - getValue(a)).slice(0, TOP_N);
}

class DatasetLoadMonitor {
  private readonly taskId: string;
  private readonly datasetPath: string;
  private readonly startedAtMs: number;
  private phase = "init";
  private intervalId: number | null = null;
  private lastTickMs = 0;
  private stalls: StallSample[] = [];
  private longTasks: LongTaskSample[] = [];
  private longTaskObserver: PerformanceObserver | null = null;
  private done = false;

  constructor(taskId: string, datasetPath: string) {
    this.taskId = taskId;
    this.datasetPath = datasetPath;
    this.startedAtMs = performance.now();
    this.lastTickMs = this.startedAtMs;
    this.start();
  }

  private start(): void {
    if (!hasWindow) return;

    this.intervalId = window.setInterval(() => {
      const now = performance.now();
      const elapsedMs = now - this.lastTickMs;
      const stallMs = elapsedMs - CHECK_INTERVAL_MS;
      this.lastTickMs = now;

      if (stallMs >= STALL_THRESHOLD_MS) {
        this.stalls.push({ atMs: now - this.startedAtMs, stallMs, phase: this.phase });
      }
    }, CHECK_INTERVAL_MS);

    if (typeof PerformanceObserver !== "undefined") {
      try {
        this.longTaskObserver = new PerformanceObserver((list) => {
          const now = performance.now();
          for (const entry of list.getEntries()) {
            const durationMs = entry.duration;
            if (durationMs >= STALL_THRESHOLD_MS) {
              this.longTasks.push({
                atMs: now - this.startedAtMs,
                durationMs,
                phase: this.phase,
              });
            }
          }
        });
        this.longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch {
        this.longTaskObserver = null;
      }
    }
  }

  public setPhase(phase: string): void {
    this.phase = phase;
  }

  public stop(status: LoadStatus): DatasetLoadReport {
    if (this.done) {
      return this.buildReport(status);
    }

    this.done = true;
    if (this.intervalId != null && hasWindow) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;

    const report = this.buildReport(status);
    this.emit(report);
    return report;
  }

  private buildReport(status: LoadStatus): DatasetLoadReport {
    const endedAtMs = performance.now();
    const topStalls = takeTopBy(this.stalls, (s) => s.stallMs);
    const topLongTasks = takeTopBy(this.longTasks, (s) => s.durationMs);
    const maxStall = topStalls[0];
    const maxLongTask = topLongTasks[0];

    return {
      taskId: this.taskId,
      datasetPath: this.datasetPath,
      startedAtMs: this.startedAtMs,
      endedAtMs,
      totalMs: endedAtMs - this.startedAtMs,
      status,
      phaseAtEnd: this.phase,
      maxStallMs: maxStall?.stallMs ?? 0,
      maxStallPhase: maxStall?.phase ?? "n/a",
      stallCount: this.stalls.length,
      topStalls,
      longTaskCount: this.longTasks.length,
      maxLongTaskMs: maxLongTask?.durationMs ?? 0,
      maxLongTaskPhase: maxLongTask?.phase ?? "n/a",
      topLongTasks,
    };
  }

  private emit(report: DatasetLoadReport): void {
    console.groupCollapsed(
      `[DatasetLoadInstrumentation] ${report.status} ${this.datasetPath} | max stall ${report.maxStallMs.toFixed(1)}ms (${report.maxStallPhase})`
    );
    console.log(report);
    if (report.topStalls.length > 0) {
      console.table(
        report.topStalls.map((s) => ({
          atMs: Number(s.atMs.toFixed(1)),
          stallMs: Number(s.stallMs.toFixed(1)),
          phase: s.phase,
        }))
      );
    }
    if (report.topLongTasks.length > 0) {
      console.table(
        report.topLongTasks.map((s) => ({
          atMs: Number(s.atMs.toFixed(1)),
          durationMs: Number(s.durationMs.toFixed(1)),
          phase: s.phase,
        }))
      );
    }
    console.groupEnd();

    if (hasWindow) {
      window.dispatchEvent(
        new CustomEvent("dataset-load-instrumentation", {
          detail: report,
        })
      );
    }
  }
}

export function startDatasetLoadMonitor(taskId: string, datasetPath: string): DatasetLoadMonitorHandle {
  const monitor = new DatasetLoadMonitor(taskId, datasetPath);
  activeMonitor = monitor;
  return {
    setPhase: (phase: string) => {
      if (activeMonitor === monitor) monitor.setPhase(phase);
    },
    stop: (status: LoadStatus) => {
      const report = monitor.stop(status);
      if (activeMonitor === monitor) activeMonitor = null;
      return report;
    },
  };
}

// Boot attribution (issue #315 P1): a monitor-independent, always-on phase
// timeline. The monitor only exists for tab-panel loads; deep-link boots
// (and the bench harness) never start one, so the timeline records phase
// CHANGES here (chunk loops re-mark the same phase per chunk — only
// transitions matter) and mirrors to window for bench/boot-compare.mjs.
const bootPhaseTimeline: Array<{ phase: string; atMs: number }> = [];
let lastMarkedPhase: string | null = null;

export function markDatasetLoadPhase(phase: string): void {
  activeMonitor?.setPhase(phase);
  if (phase !== lastMarkedPhase) {
    lastMarkedPhase = phase;
    bootPhaseTimeline.push({ phase, atMs: performance.now() });
    if (hasWindow) {
      (window as unknown as { __bootTimeline?: unknown }).__bootTimeline = bootPhaseTimeline;
    }
  }
}
