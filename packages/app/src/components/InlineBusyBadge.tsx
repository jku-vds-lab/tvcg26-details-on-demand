import { Box, CircularProgress, Typography } from "@mui/material";

interface InlineBusyBadgeProps {
  open: boolean;
  label?: string;
}

const InlineBusyBadge: React.FC<InlineBusyBadgeProps> = ({ open, label = "Updating…" }) => {
  if (!open) return null;
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1, ml: 1 }}>
      <CircularProgress size={14} />
      <Typography variant="caption">{label}</Typography>
    </Box>
  );
};

export default InlineBusyBadge;
