// packages/app/src/components/PredefinedDatasets.tsx
import {
  Box,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Tooltip,
  Typography,
} from "@mui/material";
import React, { useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { scalingBuildHasBackends } from "@scaling";
import type { RootState } from "../store";
import {
  CCTVIcon,
  ChessPawnIcon,
  DotsGridIcon,
  GymnasiumIcon,
  PaperDocIcon,
  QuestionIcon,
  RubikCubeIcon,
} from "./icons/InlineIcons";
import {
  DatasetEntry,
  DatasetKind,
  isDatasetEntryLocked,
  isLocalHost,
  PREDEFINED_DATASETS,
  resolveDatasetFetchPath,
} from "../datasets/catalog";
import { useGymUnlocked } from "../datasets/gymUnlock";

export type { DatasetKind, DatasetEntry };

function getDatasetTypeMeta(kind: DatasetKind): { label: string; Icon: typeof QuestionIcon } {
  switch (kind) {
    case "chess":
      return { label: "Chess", Icon: ChessPawnIcon };
    case "rubik":
      return { label: "Rubik’s Cube", Icon: RubikCubeIcon };
    case "mnist":
      return { label: "MNIST", Icon: DotsGridIcon };
    case "cctv":
      return { label: "CCTV", Icon: CCTVIcon };
    case "gymnasium":
      return { label: "Gymnasium", Icon: GymnasiumIcon };
    case "default":
      return { label: "Paper", Icon: PaperDocIcon };
    default:
      return { label: kind.charAt(0).toUpperCase() + kind.slice(1), Icon: QuestionIcon };
  }
}

// Category rendering order (UI groups).
const CATEGORY_ORDER: DatasetKind[] = ["cctv", "chess", "rubik", "mnist", "gymnasium", "default"];

/**
 * Predefined dataset chooser.
 * Emits the **full DatasetEntry** to onChange (cleanest integration + future-proofing).
 */
const PredefinedDatasets: React.FC<{
  onChange: (entry: DatasetEntry) => void;
  entries?: DatasetEntry[];
}> = ({ onChange, entries }) => {
  const sidePanelBgColor = useSelector((s: RootState) => s.visualizationSettings.sidePanelBgColor);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const gymUnlocked = useGymUnlocked();

  // localOnly availability probes (2026-08-05, CS's dead-click report):
  // - gymnasium rows are teasers unless their per-env render service
  //   answers /health (the manifest's render.endpoint, one small manifest
  //   fetch + one probe per row) — down ⇒ grayed "coming soon";
  // - other localOnly rows get one HEAD probe: gitignored files absent in
  //   this checkout/worktree gray the row as "files missing".
  const [missingPaths, setMissingPaths] = useState<ReadonlySet<string>>(new Set());
  const [gymDownPaths, setGymDownPaths] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!isLocalHost()) return;
    let cancelled = false;
    const timeoutSignal = () =>
      typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(2500) : undefined;
    const candidates = (entries ?? PREDEFINED_DATASETS).filter((e) => e.localOnly);
    void Promise.all(
      candidates.map(async (e) => {
        const isGym = (e.datasetType?.toLowerCase?.() ?? "") === "gymnasium";
        try {
          const path = resolveDatasetFetchPath(e.path);
          if (!isGym) {
            const r = await fetch(path, { method: "HEAD" });
            return r.ok ? null : { path: e.path, kind: "missing" as const };
          }
          const r = await fetch(path, { signal: timeoutSignal() });
          if (!r.ok) return { path: e.path, kind: "gymDown" as const };
          const m = (await r.json()) as { render?: { endpoint?: string } };
          const endpoint = m.render?.endpoint;
          if (!endpoint) return null;
          await fetch(`${endpoint.replace(/\/+$/, "")}/health`, { signal: timeoutSignal() });
          return null;
        } catch {
          return { path: e.path, kind: isGym ? ("gymDown" as const) : ("missing" as const) };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const missing = new Set<string>();
      const gymDown = new Set<string>();
      for (const r of results) {
        if (!r) continue;
        (r.kind === "missing" ? missing : gymDown).add(r.path);
      }
      if (missing.size > 0) setMissingPaths(missing);
      if (gymDown.size > 0) setGymDownPaths(gymDown);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  // Normalize for grouping/rendering (do not mutate caller data). Datasets
  // that REQUIRE a backend are HIDDEN outright on provider-less builds (CS
  // 2026-08-05): the public frontend should neither advertise server
  // functionality nor list rows a user can never use — unlike the gym rows,
  // which stay as grayed teasers by design.
  const data: DatasetEntry[] = useMemo(
    () =>
      (entries ?? PREDEFINED_DATASETS)
        .filter((e) => scalingBuildHasBackends || e.requiresBackend !== true)
        .map((e) => ({
          ...e,
          datasetType: e.datasetType?.toLowerCase?.() || "default",
        })),
    [entries]
  );

  const groups = useMemo(() => {
    // Build grouping map; remap specific dataset types to display categories
    const byType = new Map<DatasetKind, DatasetEntry[]>();
    for (const e of data) {
      const groupKey: DatasetKind = (e.datasetType || "default") as DatasetKind;
      if (!byType.has(groupKey)) byType.set(groupKey, []);
      byType.get(groupKey)!.push(e);
    }
    const extras = [...byType.keys()].filter((k) => !CATEGORY_ORDER.includes(k)).sort();
    const order = [...CATEGORY_ORDER.filter((k) => byType.has(k)), ...extras];
    return order.map((k) => ({ key: k, items: byType.get(k)! }));
  }, [data]);

  return (
    <Box
      sx={{
        overflowY: "auto",
        height: "100%",
        minHeight: 280,
        flex: "1 1 auto",
        bgcolor: sidePanelBgColor,
        borderRadius: 2,
        border: (t) => `1px solid ${t.palette.divider}`,
      }}
    >
      <List
        subheader={<li />}
        sx={{
          py: 0,
          "& .MuiListSubheader-root": {
            position: "sticky",
            top: 0,
            zIndex: 1,
            bgcolor: sidePanelBgColor,
            backdropFilter: "blur(4px)",
          },
        }}
      >
        {groups.map(({ key, items }) => {
          const { label } = getDatasetTypeMeta(key);
          return (
            <li key={key}>
              <ul style={{ paddingInlineStart: 0, margin: 0 }}>
                <ListSubheader
                  component="div"
                  disableGutters
                  sx={{ px: 2, py: 1.25, pointerEvents: "none", userSelect: "none" }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 700,
                        letterSpacing: 0.8,
                        textTransform: "uppercase",
                        color: "text.secondary",
                      }}
                    >
                      {label}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ ml: "auto", color: "text.disabled", fontWeight: 600 }}
                    >
                      {items.length}
                    </Typography>
                  </Box>
                  <Divider sx={{ mt: 0.9 }} />
                </ListSubheader>

                {items.map((entry) => {
                  const effectiveIconKind: DatasetKind = entry.iconKind ?? entry.datasetType;
                  const { Icon: RowIcon } = getDatasetTypeMeta(effectiveIconKind);
                  const backendLocked = entry.requiresBackend === true && !scalingBuildHasBackends;
                  const filesMissing = missingPaths.has(entry.path);
                  const isGymRow = entry.datasetType === "gymnasium";
                  const gymDown = isGymRow && gymDownPaths.has(entry.path);
                  const isLocked =
                    isDatasetEntryLocked(entry, undefined, gymUnlocked) || filesMissing || gymDown;
                  // Gym rows are TEASERS whenever locked — "coming soon", never
                  // an error state (CS 2026-08-05): they hint at the RL
                  // integration and unlock by running the local render services.
                  const lockTitle = isGymRow
                    ? "RL environments — coming soon. Locally: start-render-services.bat (RUN-LOCALLY-GYM.md)"
                    : backendLocked
                      ? "Needs its dataset service — available in the server build only"
                      : filesMissing
                        ? "Dataset files not found in this checkout (gitignored — regenerate locally)"
                        : "Needs the local render services: run from a clone (RUN-LOCALLY-GYM.md)";
                  const lockChip = isGymRow
                    ? "coming soon"
                    : backendLocked
                      ? "server build only"
                      : filesMissing
                        ? "files missing"
                        : "server build only";
                  const handleClick = () => {
                    if (isLocked) return;
                    setSelectedPath(entry.path);
                    onChange(entry);
                  }; // pass the full entry (best practice)
                  return (
                    <ListItem key={entry.path} disablePadding>
                      <Tooltip
                        title={isLocked ? lockTitle : entry.path}
                        arrow
                        enterDelay={400}
                      >
                        <ListItemButton
                          onClick={handleClick}
                          dense
                          disabled={isLocked}
                          selected={selectedPath === entry.path}
                          sx={{
                            px: 1.5,
                            py: 0.5,
                            borderRadius: 0.75,
                            "&:hover": {
                              backgroundColor: "action.hover",
                            },
                            "&.Mui-selected": {
                              backgroundColor: "action.selected",
                            },
                          }}
                        >
                          <ListItemIcon sx={{ minWidth: 36 }}>
                            <RowIcon fontSize="small" />
                          </ListItemIcon>
                          <ListItemText
                            primary={entry.display}
                            primaryTypographyProps={{ noWrap: true }}
                          />
                          {isLocked && <Chip size="small" label={lockChip} sx={{ ml: 1 }} />}
                        </ListItemButton>
                      </Tooltip>
                    </ListItem>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </List>
    </Box>
  );
};

export default PredefinedDatasets;

