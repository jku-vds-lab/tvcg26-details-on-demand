import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Box,
    Button,
    Chip,
    Divider,
    Stack,
    Typography,
} from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import React, { useEffect, useMemo, useState } from "react";
import { useLabeling } from "../../hooks/useLabeling";
import { useUndoRedoAndSessions } from "../../hooks/useUndoRedoAndSessions";
import type { LabelingSession } from "../../services/SessionPersistenceService";
import { SessionHistoryIcon } from "../icons/InlineIcons";
import styles from "./SessionsPanel.module.css";

const accordionCardSx: SxProps<Theme> = {
  borderRadius: 2,
  border: (theme: Theme) => `1px solid ${theme.palette.divider}`,
  boxShadow: "none",
  backgroundColor: (theme) => theme.palette.background.paper,
  "&:before": { display: "none" },
};

export const SessionsPanel: React.FC = () => {
  const labeling = useLabeling();
  const { getRecentSessions, loadSession, deleteSession } = useUndoRedoAndSessions();
  const [sessions, setSessions] = useState<LabelingSession[]>([]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  const refreshSessions = useMemo(
    () => () => {
      setSessions(getRecentSessions(labeling.metadata.datasetKey, 12));
    },
    [getRecentSessions, labeling.metadata.datasetKey]
  );

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const handleLoadSession = (sessionId: string) => {
    if (loadSession(sessionId)) {
      setExpandedSessionId(null);
      refreshSessions();
    } else {
      window.alert("Failed to load session");
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
    deleteSession(sessionId);
    setSessions((prev) => prev.filter((session) => session.id !== sessionId));
    if (expandedSessionId === sessionId) setExpandedSessionId(null);
  };

  const formatTimeAgo = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const topLabelCounts = (session: LabelingSession) => {
    const counts = new Map<string, number>();
    Object.values(session.labels).forEach((label) => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    });

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4);
  };

  return (
    <Accordion sx={accordionCardSx} className={styles.panel} defaultExpanded={false} disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} className={styles.summary}>
        <Box className={styles.headerText}>
          <SessionHistoryIcon sx={{ fontSize: 24, flexShrink: 0 }} />
          <Box>
            <Typography variant="subtitle1" className={styles.title}>
              Sessions
            </Typography>
            <Typography variant="body2" className={styles.subtitle}>
              Restore or remove previous saves for this dataset.
            </Typography>
          </Box>
        </Box>
      </AccordionSummary>

      <AccordionDetails className={styles.details}>
        <Divider sx={{ mb: 1.5 }} />

        {sessions.length === 0 ? (
          <Box className={styles.emptyState}>
            <Typography variant="body2" className={styles.emptyTitle}>
              No saved sessions yet
            </Typography>
            <Typography variant="caption" className={styles.emptyCopy}>
              Autosaves and manual saves will appear here.
            </Typography>
          </Box>
        ) : (
          <Stack className={styles.sessionsList} spacing={1}>
            {sessions.map((session) => {
              const isExpanded = expandedSessionId === session.id;

              return (
                <Box
                  key={session.id}
                  className={styles.sessionCard}
                  data-autosave={session.isAutosave ? "true" : "false"}
                >
                  <Button
                    type="button"
                    className={styles.sessionSummary}
                    onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                    endIcon={<ExpandMoreIcon className={isExpanded ? styles.expandedIcon : styles.collapsedIcon} />}
                  >
                    <Box className={styles.sessionSummaryText}>
                      <Typography variant="body1" className={styles.sessionName}>
                        {session.name}
                      </Typography>
                      <Box className={styles.metaRow}>
                        <Chip size="small" label={formatTimeAgo(session.modifiedAt)} className={styles.metaChip} />
                        <Chip size="small" label={`${Object.keys(session.labels).length} labels`} className={styles.metaChip} />
                        {session.isAutosave && (
                          <Chip size="small" label="Autosave" className={styles.autosaveChip} />
                        )}
                      </Box>
                    </Box>
                  </Button>

                  {isExpanded && (
                    <Box className={styles.sessionDetails}>
                      <Box className={styles.detailGrid}>
                        <Typography variant="caption" className={styles.detailLabel}>
                          Created
                        </Typography>
                        <Typography variant="body2" className={styles.detailValue}>
                          {new Date(session.createdAt).toLocaleString()}
                        </Typography>
                        <Typography variant="caption" className={styles.detailLabel}>
                          Modified
                        </Typography>
                        <Typography variant="body2" className={styles.detailValue}>
                          {new Date(session.modifiedAt).toLocaleString()}
                        </Typography>
                        <Typography variant="caption" className={styles.detailLabel}>
                          Coverage
                        </Typography>
                        <Typography variant="body2" className={styles.detailValue}>
                          {Object.keys(session.labels).length} / {session.clusterCount}
                        </Typography>
                      </Box>

                      <Box className={styles.labelPreview}>
                        <Typography variant="caption" className={styles.previewTitle}>
                          Top labels
                        </Typography>
                        <Box className={styles.labelChips}>
                          {topLabelCounts(session).map(([label, count]) => (
                            <Chip
                              key={label}
                              size="small"
                              label={`${label} (${count})`}
                              className={styles.labelChip}
                            />
                          ))}
                        </Box>
                      </Box>

                      <Box className={styles.actionsRow}>
                        <Button variant="outlined" size="small" onClick={() => handleLoadSession(session.id)}>
                          Load
                        </Button>
                        <Button variant="outlined" size="small" color="error" onClick={() => handleDeleteSession(session.id)}>
                          Delete
                        </Button>
                      </Box>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </AccordionDetails>
    </Accordion>
  );
};