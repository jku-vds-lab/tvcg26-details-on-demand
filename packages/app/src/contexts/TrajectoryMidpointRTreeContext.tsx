import type rbush from 'rbush';
import { createContext, MutableRefObject, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { RTreeItem, TrajectoryMidpoint } from '../dataPreprocessing/dataPreprocessing';

const TrajectoryMidpointRTreeContext = createContext<MutableRefObject<rbush<RTreeItem<TrajectoryMidpoint>> | null> | null>(null);

// The tree is filled by a background chunked build (usePrepareDatasetRefs) and
// read via .current at render time — a plain ref gives consumers no re-render
// when it lands (mirror of RTreeContext's ready flag; a counter because the
// ref is assigned once per dataset swap and once when the real tree is built).
interface MidpointRTreeVersionCtx { version: number; bumpVersion: () => void }
const TrajectoryMidpointRTreeVersionContext = createContext<MidpointRTreeVersionCtx | null>(null);

export const TrajectoryMidpointRTreeProvider = ({ children }: { children: ReactNode }) => {
  const rTreeRef = useRef<rbush<RTreeItem<TrajectoryMidpoint>> | null>(null);
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);
  const versionCtx = useMemo(() => ({ version, bumpVersion }), [version, bumpVersion]);
  return (
    <TrajectoryMidpointRTreeContext.Provider value={rTreeRef}>
      <TrajectoryMidpointRTreeVersionContext.Provider value={versionCtx}>
        {children}
      </TrajectoryMidpointRTreeVersionContext.Provider>
    </TrajectoryMidpointRTreeContext.Provider>
  );
};

export const useTrajectoryMidpointRTreeRef = (): MutableRefObject<rbush<RTreeItem<TrajectoryMidpoint>> | null> => {
  const ctx = useContext(TrajectoryMidpointRTreeContext);
  if (!ctx) throw new Error('useTrajectoryMidpointRTreeRef must be used within a TrajectoryMidpointRTreeProvider');
  return ctx;
};

export const useTrajectoryMidpointRTreeVersion = (): MidpointRTreeVersionCtx => {
  const ctx = useContext(TrajectoryMidpointRTreeVersionContext);
  if (!ctx) throw new Error('useTrajectoryMidpointRTreeVersion must be used within a TrajectoryMidpointRTreeProvider');
  return ctx;
};
