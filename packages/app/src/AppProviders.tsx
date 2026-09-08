import React from "react";
import { DataProvider } from "./contexts/DataContext";
import { RTreeProvider } from "./contexts/RTreeContext";
import { SegmentsProvider } from "./contexts/SegmentsContext";
import { SegmentsRTreeProvider } from "./contexts/SegmentsRTreeContext";
import { TrajectoryMidpointRTreeProvider } from "./contexts/TrajectoryMidpointRTreeContext";
import { TrajectoryMidpointsProvider } from "./contexts/TrajectoryMidpointsContext";

interface AppProvidersProps {
  children: React.ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <DataProvider>
      <SegmentsProvider>
        <TrajectoryMidpointsProvider>
          <RTreeProvider>
            <SegmentsRTreeProvider>
              <TrajectoryMidpointRTreeProvider>{children}</TrajectoryMidpointRTreeProvider>
            </SegmentsRTreeProvider>
          </RTreeProvider>
        </TrajectoryMidpointsProvider>
      </SegmentsProvider>
    </DataProvider>
  );
}
