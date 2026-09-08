import { Box, IconButton, LinearProgress, Paper, Typography } from "@mui/material";
import { X as CloseIcon, Cpu, Download } from "lucide-react"; // lucide-react available per project rules
import { useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../store";
import BaseSnackbar, { anchorOrigin, SNACKBAR_BG_COLOR, SNACKBAR_TEXT_COLOR } from "./BaseSnackbar";

type Task = RootState extends { progress: infer P }
  ? P extends { tasks: infer T }
    ? T extends Record<string, unknown>
      ? T[keyof T]
      : never
    : never
  : never;

const MAX_CARDS = 3;
// Reference unused imports to satisfy TypeScript
void IconButton;
void CloseIcon;
void anchorOrigin;

function groupTasks(tasks: Task[]) {
  const byParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of tasks) {
    if (t.parentId) {
      const arr = byParent.get(t.parentId) ?? [];
      arr.push(t);
      byParent.set(t.parentId, arr);
    } else {
      roots.push(t);
    }
  }
  return { byParent, roots };
}

/**
 * Cumulative group progress (issue #315 Task 3 round 2): completed phases
 * (`doneCount`, from progressSlice.groupDone) keep their full share and live
 * phases contribute their fraction, so the single card's bar moves FORWARD
 * across a load instead of resetting per phase. Indeterminate live phases
 * count in the total with zero contribution. Exported for tests.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure summary math, exported for tests only
export function computeParentSummary(
  children: Task[],
  doneCount: number,
  /** True while the load's ROOT task is still alive: more phases WILL come,
   * so one pending slot joins the total — the bar cannot preempt 99/100%
   * during a between-phases gap (CS round 3: "jumps to 99% then back"). */
  reservePending = false
) {
  const total = doneCount + children.length + (reservePending ? 1 : 0);
  const liveFraction = children.reduce(
    (s, t) => s + (typeof t.value === "number" ? Math.min(t.value, 100) / 100 : 0),
    0
  );
  const determinate =
    doneCount > 0 || children.some((t) => typeof t.value === "number");
  const pct = determinate && total > 0
    ? Math.round((100 * (doneCount + liveFraction)) / total)
    : undefined;
  return { count: total, doneCount, pct };
}

export default function GlobalProgressDock() {
  const progress = useSelector((s: RootState) => s.progress);
  // Monotonic display clamp per group: never render a lower percent than
  // already shown for the same parent (a newly-registered phase grows the
  // denominator, which must not read as the bar jumping backward).
  const shownPctRef = useRef(new Map<string, number>());

  // When a task has a minShowMs guard, it is invisible on the first render
  // (startedAt ≈ now).  The next Redux dispatch only happens on completeTask,
  // which deletes the task — so without this timer the indicator never appears.
  // Schedule a forced re-render at the earliest minShowMs boundary so the dock
  // can show tasks that are still in flight once the guard window has elapsed.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const allTasks = Object.values(progress?.tasks ?? {}) as Task[];
    const now = performance.now();
    const delays = allTasks
      .filter((t) => t.minShowMs && now - t.startedAt < t.minShowMs)
      .map((t) => t.startedAt + t.minShowMs! - now);
    if (delays.length === 0) return;
    const delay = Math.max(0, Math.min(...delays));
    const timer = setTimeout(() => setTick((x) => x + 1), delay);
    return () => clearTimeout(timer);
  }, [progress]);

  const tasks = useMemo(() => {
    const ids = progress?.lastOrder ?? [];
    const list: Task[] = [];
    for (const id of ids) {
      const t = progress?.tasks?.[id];
      if (t) list.push(t);
    }
    // Apply minShowMs (filter out ultra-fast tasks that finish before the guard)
    const now = performance.now();
    return list.filter((t) => (t.minShowMs ? now - t.startedAt >= t.minShowMs : true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick is the forced-recompute trigger for the minShowMs timer above; the output changes via performance.now()
  }, [progress, tick]);

  if (!progress || tasks.length === 0) return null;

  // Compose cards: parent groups first (by most recent child), then roots.
  // A root with completed-phase HISTORY (groupDone) is also a group card even
  // while no child is live — its own raw value (e.g. "Activating… 99%") must
  // never flash between phases (CS round 3: "jumps to 99% then back").
  const { byParent, roots } = groupTasks(tasks);
  const groupIds = new Set(byParent.keys());
  for (const t of roots) {
    if ((progress.groupDone?.[t.id] ?? 0) > 0) groupIds.add(t.id);
  }
  const parentCards = Array.from(groupIds)
    .map((pid) => {
      const children = byParent.get(pid) ?? [];
      const rootTask = tasks.find((t) => t.id === pid) ?? null;
      const mostRecentChild = children.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
      const task = mostRecentChild ?? rootTask;
      return task
        ? { type: "parent" as const, id: pid, task, children, rootAlive: rootTask !== null }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const rootCards = roots
    .filter((t: Task) => !groupIds.has(t.id))
    .map((t: Task) => ({ type: "root" as const, id: t.id, task: t }));

  const cards = [...parentCards, ...rootCards]
    .sort((a, b) => (a.task.startedAt > b.task.startedAt ? -1 : 1))
    .slice(0, MAX_CARDS);

  // Drop clamp entries only when the GROUP is truly over (its groupDone was
  // cleaned up and nothing is grouped): the high-water mark must survive
  // between-phases gaps, or the bar restarts lower on the next phase.
  for (const id of shownPctRef.current.keys()) {
    if (!groupIds.has(id) && !(progress.groupDone?.[id] > 0)) {
      shownPctRef.current.delete(id);
    }
  }

  return (
    <BaseSnackbar
      open={true}
      autoHideDuration={undefined}
      message={
        <Box sx={{ display: "flex", flexDirection: "column", width: 420, gap: 1 }}>
          {cards.map((c) => {
            if (c.type === "parent") {
              const done = progress.groupDone?.[c.id] ?? 0;
              const { count, pct } = computeParentSummary(
                c.children as Task[],
                done,
                c.rootAlive
              );
              const childIdx = (c.children as Task[]).findIndex((t) => t.id === c.task.id);
              const ordinal = done + (childIdx >= 0 ? childIdx + 1 : 0);
              const icon =
                c.task.kind === "io" ? (
                  <Download size={16} />
                ) : (
                  <Cpu size={16} />
                );
              let shownPct = pct;
              if (typeof pct === "number") {
                const prev = shownPctRef.current.get(c.id) ?? 0;
                shownPct = Math.max(prev, pct);
                shownPctRef.current.set(c.id, shownPct);
              }
              const determinate = typeof shownPct === "number";
              return (
                <Paper
                  key={c.id}
                  sx={{ p: 1.25, backgroundColor: SNACKBAR_BG_COLOR, color: SNACKBAR_TEXT_COLOR }}
                  elevation={2}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {icon}
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {count > 1 && ordinal >= 1
                        ? `${c.task.label} (${ordinal}/${count})`
                        : c.task.label}
                    </Typography>
                  </Box>
                  <Typography variant="caption" sx={{ opacity: 0.8 }}>
                    {c.task.phase ?? ""}
                  </Typography>
                  <LinearProgress
                    variant={determinate ? "determinate" : "indeterminate"}
                    value={determinate ? shownPct : undefined}
                    sx={{ mt: 1 }}
                  />
                </Paper>
              );
            }

            const t = (c as { task: Task }).task;
            const icon = t.kind === "io" ? <Download size={16} /> : <Cpu size={16} />;
            const determinate = typeof t.value === "number";

            return (
              <Paper
                key={t.id}
                sx={{ p: 1.25, backgroundColor: SNACKBAR_BG_COLOR, color: SNACKBAR_TEXT_COLOR }}
                elevation={2}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {icon}
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {t.label} {determinate ? `${Math.round(t.value as number)}%` : ""}
                  </Typography>
                </Box>
                <Typography variant="caption" sx={{ opacity: 0.8 }}>
                  {t.phase ?? ""}
                </Typography>
                <LinearProgress
                  variant={determinate ? "determinate" : "indeterminate"}
                  value={determinate ? (t.value as number) : undefined}
                  sx={{ mt: 1 }}
                />
              </Paper>
            );
          })}
        </Box>
      }
    />
  );
}
