// packages/app/src/components/upload/uploadFileRouting.ts
//
// Routing for files dropped onto the Dataset tab (issue #217): CSVs go
// through the simple-format upload wizard; JSON/JSON.GZ files are treated
// as the bespoke preprocessed format and loaded directly. Multipart
// manifests cannot be dropped (their chunk files are separate).

/** Existing inset rendering types offered by the wizard; "default" = generic fallback. */
export const UPLOAD_DATASET_TYPES = [
  "default",
  "chess",
  "rubik",
  "mnist",
  "cctv",
  "cartpole",
] as const;

export type DroppedFileKind = "csv" | "json" | "json-gz" | "unsupported";

export function classifyDroppedFile(fileName: string): DroppedFileKind {
  const name = fileName.toLowerCase();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".json.gz")) return "json-gz";
  if (name.endsWith(".json")) return "json";
  return "unsupported";
}
