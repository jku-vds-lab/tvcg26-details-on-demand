// components/Visualization/CanvasContainer.tsx

import React, { forwardRef } from 'react';

interface CanvasContainerProps {
  style?: React.CSSProperties;
}

const CanvasContainer = forwardRef<HTMLDivElement, CanvasContainerProps>(({ style }, ref) => {
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        ...style,
      }}
    />
  );
});

CanvasContainer.displayName = 'CanvasContainer';
export default CanvasContainer;
