import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RGB | null {
  const normalizedHex = hex.startsWith("#") ? hex.slice(1) : hex;
  const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalizedHex);

  return match
    ? {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16),
      }
    : null;
}

export function encodeColorToVec3(hex: string, fallback: RGB = { r: 0, g: 0, b: 0 }): [
  number,
  number,
  number,
] {
  const rgb = hexToRgb(hex) ?? fallback;
  return [rgb.r / 255, rgb.g / 255, rgb.b / 255];
}

export function packColorToUint8Array(colors: string[]): Uint8Array {
  const packed = new Uint8Array(colors.length * 3);
  colors.forEach((hex, idx) => {
    const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
    const offset = idx * 3;
    packed[offset] = rgb.r;
    packed[offset + 1] = rgb.g;
    packed[offset + 2] = rgb.b;
  });
  return packed;
}

function readPointValue(point: DataPoint, key: string): unknown {
  if (!key) return undefined;
  const recordPoint = point as unknown as Record<string, unknown>;
  if (key in recordPoint && recordPoint[key] !== undefined) {
    return recordPoint[key];
  }
  if (point.features && key in point.features) {
    return point.features[key];
  }
  return undefined;
}

export function getColorEncodingKey(point: DataPoint, encoding?: string): string | number | null {
  if (!encoding) return null;

  const value = readPointValue(point, encoding);
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return null;
}
