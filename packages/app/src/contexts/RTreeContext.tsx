import { createContext, MutableRefObject, ReactNode, useContext, useRef, useState } from 'react';
import type rbush from 'rbush';
import type { DataPoint, RTreeItem } from '../dataPreprocessing/dataPreprocessing';

const RTreeContext = createContext<MutableRefObject<rbush<RTreeItem<DataPoint>> | null> | null>(null);

interface RTreeReadyCtx { ready: boolean; setReady: (v: boolean) => void }
const RTreeReadyContext = createContext<RTreeReadyCtx | null>(null);

export const RTreeProvider = ({ children }: { children: ReactNode }) => {
  const rTreeRef = useRef<rbush<RTreeItem<DataPoint>> | null>(null);
  const [ready, setReady] = useState(false);
  return (
    <RTreeContext.Provider value={rTreeRef}>
      <RTreeReadyContext.Provider value={{ ready, setReady }}>
        {children}
      </RTreeReadyContext.Provider>
    </RTreeContext.Provider>
  );
};

export const useRTreeRef = (): MutableRefObject<rbush<RTreeItem<DataPoint>> | null> => {
  const ctx = useContext(RTreeContext);
  if (!ctx) throw new Error('useRTreeRef must be used within a RTreeProvider');
  return ctx;
};

export const useRTreeReady = (): RTreeReadyCtx => {
  const ctx = useContext(RTreeReadyContext);
  if (!ctx) throw new Error('useRTreeReady must be used within a RTreeProvider');
  return ctx;
};
