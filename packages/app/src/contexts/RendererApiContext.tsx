import React, { createContext, useContext } from "react";
import type { MutableRefObject } from "react";
import type { RendererAPI } from "../gl/api/RendererAPI";

export type RendererApiRef = MutableRefObject<RendererAPI | null>;

const RendererApiContext = createContext<RendererApiRef | null>(null);

export function RendererApiProvider(props: { value: RendererApiRef; children: React.ReactNode }) {
  return <RendererApiContext.Provider value={props.value}>{props.children}</RendererApiContext.Provider>;
}

export function useRendererApiRef(): RendererApiRef {
  const ctx = useContext(RendererApiContext);
  if (!ctx) throw new Error("useRendererApiRef must be used within <RendererApiProvider>");
  return ctx;
}

export function useRendererApi(): RendererAPI | null {
  return useRendererApiRef().current;
}
