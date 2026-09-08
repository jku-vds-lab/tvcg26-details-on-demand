import { useTheme } from '@mui/material/styles';
import React, { useCallback, useState } from "react";

interface DragAndDropProps {
  accept: string;
  handleDrop: (files: FileList | null) => void;
  children: React.ReactNode;
}

// const DragAndDrop: React.FC<DragAndDropProps> = ({ accept, handleDrop, children }) => { // accept currently unused
  const DragAndDrop: React.FC<DragAndDropProps> = ({ handleDrop, children }) => {
  const [isDragging, setIsDragging] = useState(false);
  const theme = useTheme();
  const primaryColor = theme.palette.primary.main;

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const files = e.dataTransfer.files;
      handleDrop(files);
    },
    [handleDrop]
  );

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        border: isDragging ? `2px dashed ${primaryColor}` : "2px dashed #888888",
        padding: "16px",
        borderRadius: "4px",
      }}
    >
      {children}
    </div>
  );
};

export default DragAndDrop;
