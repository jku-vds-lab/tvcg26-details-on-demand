// packages/app/src/components/upload/UploadWizardDialog.tsx
//
// Minimal upload wizard for the simple CSV format (issue #217 MVP):
// column-role mapping (x/y, trajectory, order, action) seeded by header
// inference, plus selection of an existing inset rendering type. Custom
// user-defined inset functions (#217 items 3.1/3.2) are out of scope.

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import React, { useEffect, useState } from "react";
import {
  inferSimpleColumnMapping,
  type SimpleColumnMapping,
} from "../../dataPreprocessing/simpleDataset";
import { UPLOAD_DATASET_TYPES } from "./uploadFileRouting";

export interface UploadWizardSubmit {
  mapping: SimpleColumnMapping;
  datasetType: string;
}

interface UploadWizardDialogProps {
  open: boolean;
  fileName: string;
  headers: string[];
  rowCount: number;
  onCancel: () => void;
  onSubmit: (result: UploadWizardSubmit) => void;
}

const NONE = "";

interface RoleSelectProps {
  label: string;
  value: string;
  headers: string[];
  required?: boolean;
  onChange: (value: string) => void;
}

const RoleSelect: React.FC<RoleSelectProps> = ({ label, value, headers, required = false, onChange }) => {
  const labelId = `upload-role-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <FormControl size="small" fullWidth required={required}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {!required && <MenuItem value={NONE}><em>None</em></MenuItem>}
        {headers.map((h) => (
          <MenuItem key={h} value={h}>{h}</MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};

const UploadWizardDialog: React.FC<UploadWizardDialogProps> = ({
  open,
  fileName,
  headers,
  rowCount,
  onCancel,
  onSubmit,
}) => {
  const [x, setX] = useState(NONE);
  const [y, setY] = useState(NONE);
  const [trajectory, setTrajectory] = useState(NONE);
  const [order, setOrder] = useState(NONE);
  const [action, setAction] = useState(NONE);
  const [label, setLabel] = useState(NONE);
  const [datasetType, setDatasetType] = useState<string>("default");

  // Seed the roles from header inference whenever a new file arrives.
  useEffect(() => {
    const inferred = inferSimpleColumnMapping(headers);
    setX(inferred.x ?? NONE);
    setY(inferred.y ?? NONE);
    setTrajectory(inferred.trajectory ?? NONE);
    setOrder(inferred.order ?? NONE);
    setAction(inferred.action ?? NONE);
    setLabel(inferred.label ?? NONE);
    setDatasetType("default");
  }, [headers]);

  const canSubmit = x !== NONE && y !== NONE && x !== y;

  const handleSubmit = () => {
    const mapping: SimpleColumnMapping = { x, y };
    if (trajectory !== NONE) mapping.trajectory = trajectory;
    if (order !== NONE) mapping.order = order;
    if (action !== NONE) mapping.action = action;
    if (label !== NONE) mapping.label = label;
    onSubmit({ mapping, datasetType });
  };

  return (
    <Dialog open={open} onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle>Load CSV dataset</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {fileName} — {rowCount.toLocaleString()} rows. Neighbor graph, trajectory
            splines, and clustering are computed in the background after loading.
          </Typography>
          <RoleSelect label="X column" value={x} headers={headers} required onChange={setX} />
          <RoleSelect label="Y column" value={y} headers={headers} required onChange={setY} />
          <RoleSelect label="Trajectory id column" value={trajectory} headers={headers} onChange={setTrajectory} />
          <RoleSelect label="Sample order column" value={order} headers={headers} onChange={setOrder} />
          <RoleSelect label="Action label column" value={action} headers={headers} onChange={setAction} />
          <RoleSelect label="Class label column" value={label} headers={headers} onChange={setLabel} />
          <FormControl size="small" fullWidth>
            <InputLabel id="upload-inset-type">Inset type</InputLabel>
            <Select
              labelId="upload-inset-type"
              label="Inset type"
              value={datasetType}
              onChange={(e) => setDatasetType(e.target.value)}
            >
              {UPLOAD_DATASET_TYPES.map((t) => (
                <MenuItem key={t} value={t}>{t}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" disabled={!canSubmit} onClick={handleSubmit}>
          Load
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default UploadWizardDialog;
