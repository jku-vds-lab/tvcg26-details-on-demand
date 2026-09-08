// Jest stand-in for vite-plugin-svgr's `*.svg?react` imports: a real React
// component (the string stub in fileMock.ts is not renderable as an element).
import React from "react";

const SvgComponentMock = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;

export default SvgComponentMock;
