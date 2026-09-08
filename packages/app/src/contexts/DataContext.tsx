import { createContext, MutableRefObject, ReactNode, useContext, useRef } from 'react';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';

const DataContext = createContext<MutableRefObject<DataPoint[]> | null>(null);

export const DataProvider = ({ children }: { children: ReactNode }) => {
  const dataRef = useRef<DataPoint[]>([]);
  return <DataContext.Provider value={dataRef}>{children}</DataContext.Provider>;
};

export const useDataRef = (): MutableRefObject<DataPoint[]> => {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useDataRef must be used within a DataProvider');
  return ctx;
};
