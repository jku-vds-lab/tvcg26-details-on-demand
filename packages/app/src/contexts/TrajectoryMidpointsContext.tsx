import { createContext, MutableRefObject, ReactNode, useContext, useRef } from 'react';
import type { TrajectoryMidpoint } from '../dataPreprocessing/dataPreprocessing';

const TrajectoryMidpointsContext = createContext<MutableRefObject<TrajectoryMidpoint[]> | null>(null);

export const TrajectoryMidpointsProvider = ({ children }: { children: ReactNode }) => {
  const midpointsRef = useRef<TrajectoryMidpoint[]>([]);
  return (
    <TrajectoryMidpointsContext.Provider value={midpointsRef}>
      {children}
    </TrajectoryMidpointsContext.Provider>
  );
};

export const useTrajectoryMidpointsRef = (): MutableRefObject<TrajectoryMidpoint[]> => {
  const ctx = useContext(TrajectoryMidpointsContext);
  if (!ctx) throw new Error('useTrajectoryMidpointsRef must be used within a TrajectoryMidpointsProvider');
  return ctx;
};
