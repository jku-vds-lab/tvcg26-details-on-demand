import { alpha, createTheme } from "@mui/material/styles";

export function createAppTheme(primaryColor = "#007dad", panelBackground = "#f6f8fb"): ReturnType<typeof createTheme> {
  return createTheme({
    palette: {
      primary: {
        main: primaryColor,
      },
      info: {
        main: primaryColor,
      },
      background: {
        paper: panelBackground,
        default: panelBackground,
      },
    },
    components: {
      MuiAccordion: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: alpha(theme.palette.background.paper, 0.78),
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: theme.shape.borderRadius,
            boxShadow: 'none',
            overflow: 'hidden',
            '&:before': {
              display: 'none',
            },
            '&.Mui-expanded': {
              margin: 0,
            },
          }),
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          root: ({ theme }) => ({
            minHeight: 48,
            backgroundColor: alpha(theme.palette.background.paper, 0.92),
            borderBottom: `1px solid ${alpha(theme.palette.divider, 0.28)}`,
            transition: 'background-color 140ms ease',
            '&.Mui-expanded': {
              minHeight: 48,
            },
            '&:hover': {
              backgroundColor: alpha(theme.palette.action.hover, 0.12),
            },
          }),
          content: {
            margin: '12px 0',
            '&.Mui-expanded': {
              margin: '12px 0',
            },
          },
        },
      },
      MuiAccordionDetails: {
        styleOverrides: {
          root: ({ theme }) => ({
            padding: theme.spacing(1.5, 2),
            backgroundColor: alpha(theme.palette.background.paper, 0.72),
          }),
        },
      },
    },
  });
}

const theme = createAppTheme();

export default theme;
