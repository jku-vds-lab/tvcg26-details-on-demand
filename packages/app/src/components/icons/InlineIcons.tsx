// packages/app/src/components/icons/InlineIcons.tsx
import { SvgIcon, type SvgIconProps } from "@mui/material";
/** If your bundler returns a URL for SVG imports, this works universally. */
import cctvUrl from "./cctv.svg";
import clockCounterClockwiseUrl from "./clock-counter-clockwise.svg";
import cubeUrl from "./cube2.svg";
import gymnasiumBlackUrl from "./gymnasium_black.svg";

/** Pawn-shaped chess icon (filled). */
export function ChessPawnIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 45 45">
      <g
        style={{
          fill: "none",
          fillRule: "evenodd",
          stroke: "#000",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      >
        <g style={{ fill: "#000", stroke: "#000", strokeLinecap: "butt" }}>
          <path d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.646,38.99 6.677,38.97 6,38 C 7.354,36.06 9,36 9,36 z" />
          <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" />
          <path d="M 25 8 A 2.5 2.5 0 1 1  20,8 A 2.5 2.5 0 1 1  25 8 z" />
        </g>
        <path d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18" style={{ stroke: "#fff" }} />
      </g>
    </SvgIcon>
  );
}

/** CCTV icon */
export function CCTVIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <image href={cctvUrl} x="0" y="0" width="24" height="24" />
    </SvgIcon>
  );
}

/** Simple cube/rubik placeholder icon (3x3 grid inside a square). */
export function CubeGridIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </SvgIcon>
  );
}

/** Dotted grid for MNIST-like pixel data. */
export function DotsGridIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      {[6, 12, 18].flatMap((y) =>
        [6, 12, 18].map((x, i) => <circle key={`${x}-${y}-${i}`} cx={x} cy={y} r={1.8} />)
      )}
      <rect x="3" y="3" width="18" height="18" fill="none" />
    </SvgIcon>
  );
}

/** Paper/document icon with folded corner and text lines. */
export function PaperDocIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 3h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
        <path d="M14 3v5h5" />
        <path d="M8 12h8M8 16h8M8 20h8" />
      </g>
    </SvgIcon>
  );
}

/** History/session icon rendered from the downloaded clock-counter-clockwise SVG asset. */
export function SessionHistoryIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <image href={clockCounterClockwiseUrl} x="0" y="0" width="24" height="24" />
    </SvgIcon>
  );
}

/** Fallback/question icon. */
export function QuestionIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path d="M9 9a3 3 0 1 1 6 0c0 2-3 3-3 5" fill="none" />
      <circle cx="12" cy="17" r="1" />
      <circle cx="12" cy="12" r="10" fill="none" />
    </SvgIcon>
  );
}

/** Simplified cart-pole icon with track, cart, and pole. */
export function CartPoleIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <line x1="3" y1="20" x2="21" y2="20" stroke="currentColor" strokeWidth={2} />
      <rect x="9" y="15" width="6" height="4" fill="currentColor" />
      <line x1="12" y1="15" x2="17" y2="5" stroke="currentColor" strokeWidth={2} />
    </SvgIcon>
  );
}

export function RubikCubeIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <image href={cubeUrl} x="0" y="0" width="24" height="24" />
    </SvgIcon>
  );
}

/** Gymnasium logo via provided SVG file. */
export function GymnasiumIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      {/* Render the external SVG as an <image>; scales with fontSize via the parent <svg>. */}
      <image href={gymnasiumBlackUrl} x="0" y="0" width="24" height="24" />
    </SvgIcon>
  );
}
