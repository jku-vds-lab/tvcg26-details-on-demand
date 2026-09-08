import React, { createContext, useContext } from "react";

export type SelectionWorkflowOptions = {
  clearFeatureSearch?: boolean;
  propagationOverride?: {
    proximitySlider: number;
    pastSlider: number;
    futureSlider: number;
  };
};

export type SelectionWorkflowHandler = (
  selectedNodeIds: number[],
  options?: SelectionWorkflowOptions
) => Promise<void> | void;

const SelectionWorkflowContext = createContext<SelectionWorkflowHandler | null>(null);

export const SelectionWorkflowProvider: React.FC<{
  value: SelectionWorkflowHandler;
  children: React.ReactNode;
}> = ({ value, children }) => {
  return (
    <SelectionWorkflowContext.Provider value={value}>
      {children}
    </SelectionWorkflowContext.Provider>
  );
};

export const useSelectionWorkflow = (): SelectionWorkflowHandler => {
  const value = useContext(SelectionWorkflowContext);
  if (!value) {
    throw new Error("useSelectionWorkflow must be used within SelectionWorkflowProvider");
  }
  return value;
};
