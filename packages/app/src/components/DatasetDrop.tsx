import Papa from "papaparse";
import React from "react";
import { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { CSVLoader } from "../dataPreprocessing/CSVLoader";
import { JSONLoader } from "../dataPreprocessing/JSONLoader";
import { Dataset } from "../types/datasetTypes";
import DragAndDrop from "./DragAndDrop";

interface DatasetDropProps {
  onChange: (dataset: Dataset) => void;
}

const DatasetDrop: React.FC<DatasetDropProps> = ({ onChange }) => {
  const handleFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const fileName = file.name;
    if (fileName.endsWith(".csv")) {
      const rows: DataPoint[] = [];
      let header: string[] | null = null;
      // Specify that each row is a string[] so that we can avoid using "any"
      Papa.parse<string[]>(file, {
        worker: true,
        skipEmptyLines: true,
        step(results: Papa.ParseStepResult<string[]>) {
          // The very first row is assumed to be the header.
          if (!header) {
            header = results.data;
            return;
          }
          const row = results.data;
          // Build an object mapping header keys to row values.
          const dict: Record<string, string> = {};
          row.forEach((value: string, i: number) => {
            if (header && header[i]) {
              dict[header[i]] = value;
            }
          });
          // CSVLoader is expected to convert the raw strings to the proper DataPoint type.
          rows.push(dict as unknown as DataPoint);
        },
        complete() {
          new CSVLoader().resolveVectors(rows, onChange);
        },
      });
    } else if (fileName.endsWith(".json")) {
      const reader = new FileReader();
      reader.onload = (event: ProgressEvent<FileReader>) => {
        const content = event.target?.result;
        if (typeof content === "string") {
          new JSONLoader().resolveContent(content, onChange);
        }
      };
      reader.readAsText(file);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <DragAndDrop accept=".csv,.json" handleDrop={handleFiles}>
        <div
          style={{
            height: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          Drop your dataset file here
        </div>
      </DragAndDrop>
    </div>
  );
};

export default DatasetDrop;
