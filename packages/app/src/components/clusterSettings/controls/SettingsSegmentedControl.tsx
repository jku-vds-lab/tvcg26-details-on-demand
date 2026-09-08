import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  label: string;
  helperText?: string;
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (nextValue: T) => void;
};

function SettingsSegmentedControl<T extends string>({
  label,
  helperText,
  value,
  options,
  onChange,
}: Props<T>) {
  return (
    <Box sx={{ mb: 1.25 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
        {label}
      </Typography>

      <ToggleButtonGroup
        value={value}
        exclusive
        fullWidth
        size="small"
        onChange={(_, nextValue: T | null) => {
          if (!nextValue) return;
          onChange(nextValue);
        }}
        sx={{
          p: 0.25,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1.25,
          bgcolor: 'action.hover',
          '& .MuiToggleButtonGroup-grouped': {
            border: 0,
            borderRadius: 1,
            textTransform: 'none',
            fontWeight: 500,
            fontSize: '0.8rem',
            lineHeight: 1.15,
            color: 'text.secondary',
            px: 1,
            py: 0.375,
            minHeight: 28,
            '&.Mui-selected': {
              color: 'text.primary',
              bgcolor: 'background.paper',
              boxShadow: 1,
            },
          },
        }}
      >
        {options.map((option) => (
          <ToggleButton key={option.value} value={option.value}>
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {helperText && (
        <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: 'text.secondary' }}>
          {helperText}
        </Typography>
      )}
    </Box>
  );
}

export default SettingsSegmentedControl;
