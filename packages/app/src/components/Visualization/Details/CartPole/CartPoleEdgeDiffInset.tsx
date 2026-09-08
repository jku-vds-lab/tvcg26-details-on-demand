// src/components/Visualization/Details/CartPole/CartPoleEdgeDiffInset.tsx
import React, { useMemo } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { averageCluster, getSampleState } from "./CartPoleImageInset";

interface CartPoleEdgeDiffInsetProps {
  startSamples: DataPoint[];
  endSamples:   DataPoint[];
  scaleFactor:  number;
  /** Stable memo key, e.g. `${startSig}::${endSig}`. */
  samplesSig:   string;
}

const WIDTH       = 120;
const HEIGHT      = 80;
const CART_WIDTH  = 30;
const CART_HEIGHT = 15;
const POLE_LENGTH = 40;
/** Maps cart-x in [-2.4, 2.4] to screen pixels. */
const SCALE_X = (WIDTH / 2) / 2.4;

function resolveState(samples: DataPoint[]): Float32Array {
  if (samples.length === 0) return new Float32Array(4);
  if (samples.length === 1) return getSampleState(samples[0]);
  return averageCluster(samples);
}

interface CartPoleGeom {
  cartX:    number;
  cartY:    number;
  poleEndX: number;
  poleEndY: number;
}

function toGeom(state: Float32Array): CartPoleGeom {
  const [x, , theta] = state;
  const cartX    = WIDTH  / 2 + x * SCALE_X;
  const cartY    = HEIGHT * 0.75 - CART_HEIGHT;
  const poleEndX = cartX + POLE_LENGTH * Math.sin(theta);
  const poleEndY = cartY - POLE_LENGTH * Math.cos(theta);
  return { cartX, cartY, poleEndX, poleEndY };
}

const CartPoleEdgeDiffInset: React.FC<CartPoleEdgeDiffInsetProps> = ({
  startSamples,
  endSamples,
  scaleFactor,
  samplesSig,
}) => {
  const sg = useMemo(
    () => toGeom(resolveState(startSamples)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [samplesSig, startSamples.length]
  );
  const eg = useMemo(
    () => toGeom(resolveState(endSamples)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [samplesSig, endSamples.length]
  );

  const trackY = HEIGHT * 0.75;

  return (
    <svg
      width={WIDTH  * scaleFactor}
      height={HEIGHT * scaleFactor}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ overflow: "visible", pointerEvents: "none" }}
    >
      {/* Background */}
      <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="white" />

      {/* Track */}
      <line x1={0} y1={trackY} x2={WIDTH} y2={trackY} stroke="black" strokeWidth={2} />

      {/* Start state — ghosted */}
      <rect
        x={sg.cartX - CART_WIDTH / 2} y={sg.cartY}
        width={CART_WIDTH} height={CART_HEIGHT}
        fill="#ccc" opacity={0.4}
      />
      <line
        x1={sg.cartX} y1={sg.cartY}
        x2={sg.poleEndX} y2={sg.poleEndY}
        stroke="#d00" strokeWidth={2} opacity={0.3}
      />

      {/* End state — solid */}
      <rect
        x={eg.cartX - CART_WIDTH / 2} y={eg.cartY}
        width={CART_WIDTH} height={CART_HEIGHT}
        fill="#888"
      />
      <line
        x1={eg.cartX} y1={eg.cartY}
        x2={eg.poleEndX} y2={eg.poleEndY}
        stroke="#d00" strokeWidth={3}
      />
    </svg>
  );
};

export default React.memo(
  CartPoleEdgeDiffInset,
  (a, b) => a.samplesSig === b.samplesSig && a.scaleFactor === b.scaleFactor
);
