import { createContext, MutableRefObject, ReactNode, useContext, useRef } from 'react';
import type { EdgeSegmentIndex } from '../dataPreprocessing/segmentIndex';

// Spatial index over the columnar segments (issue #315 phase B1): an rbush
// over EDGES with on-demand per-segment refinement, replacing the old
// per-segment object rbush. The provider/hook names are kept so consumers
// and tests churn minimally.
const SegmentsRTreeContext = createContext<MutableRefObject<EdgeSegmentIndex | null> | null>(null);

export const SegmentsRTreeProvider = ({ children }: { children: ReactNode }) => {
  const segmentsRTreeRef = useRef<EdgeSegmentIndex | null>(null);
  return (
    <SegmentsRTreeContext.Provider value={segmentsRTreeRef}>{children}</SegmentsRTreeContext.Provider>
  );
};

export const useSegmentsRTreeRef = (): MutableRefObject<EdgeSegmentIndex | null> => {
  const ctx = useContext(SegmentsRTreeContext);
  if (!ctx) throw new Error('useSegmentsRTreeRef must be used within a SegmentsRTreeProvider');
  return ctx;
};
