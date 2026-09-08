import { createContext, MutableRefObject, ReactNode, useContext, useRef } from 'react';
import type { SegmentColumns } from '../dataPreprocessing/splineColumns';

// Resident trajectory geometry is columnar (issue #315 phase B1): one
// SegmentColumns per dataset, null before load / for point-only datasets.
const SegmentsContext = createContext<MutableRefObject<SegmentColumns | null> | null>(null);

export const SegmentsProvider = ({ children }: { children: ReactNode }) => {
  const segmentsRef = useRef<SegmentColumns | null>(null);
  return <SegmentsContext.Provider value={segmentsRef}>{children}</SegmentsContext.Provider>;
};

export const useSegmentsRef = (): MutableRefObject<SegmentColumns | null> => {
  const ctx = useContext(SegmentsContext);
  if (!ctx) throw new Error('useSegmentsRef must be used within a SegmentsProvider');
  return ctx;
};
