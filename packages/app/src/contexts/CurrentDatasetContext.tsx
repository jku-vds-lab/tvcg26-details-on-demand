import { createContext, ReactNode, useContext } from "react";
import type { Dataset } from "../types/datasetTypes";

export type CurrentDatasetSnapshot = Pick<
  Dataset,
  "data" | "datasetType" | "hdbscan" | "midpointHdbscan" | "segments" | "trajectoryMidpoints"
> & {
  sourcePath?: string;
};

const CurrentDatasetContext = createContext<CurrentDatasetSnapshot | null>(null);

export function CurrentDatasetProvider({
  value,
  children,
}: {
  value: CurrentDatasetSnapshot;
  children: ReactNode;
}) {
  return (
    <CurrentDatasetContext.Provider value={value}>
      {children}
    </CurrentDatasetContext.Provider>
  );
}

export function useCurrentDataset(): CurrentDatasetSnapshot | null {
  return useContext(CurrentDatasetContext);
}