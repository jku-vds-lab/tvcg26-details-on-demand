import type { WebGLRenderer } from "./webglRenderer";

export function disposeWebGLRenderer(r: WebGLRenderer): void {
  const gl = r.gl;

  try {
    gl.bindVertexArray(null);
  } catch {
    // ignore
  }

  try {
    gl.useProgram(null);
  } catch {
    // ignore
  }

  if (r.vaoNodes) gl.deleteVertexArray(r.vaoNodes);
  if (r.vaoEdgesQuad) gl.deleteVertexArray(r.vaoEdgesQuad);
  if (r.vaoArrows) gl.deleteVertexArray(r.vaoArrows);

  if (r.nodeBuffer) gl.deleteBuffer(r.nodeBuffer);
  if (r.nodeColorBuffer) gl.deleteBuffer(r.nodeColorBuffer);
  if (r.nodeOpacityFieldBuffer) gl.deleteBuffer(r.nodeOpacityFieldBuffer);

  if (r.edgeBuffer) gl.deleteBuffer(r.edgeBuffer);
  if (r.edgeIndexBuffer) gl.deleteBuffer(r.edgeIndexBuffer);

  if (r.arrowBuffer) gl.deleteBuffer(r.arrowBuffer);

  if (r.opacityFieldTex) gl.deleteTexture(r.opacityFieldTex);
  if (r.distFieldTex) gl.deleteTexture(r.distFieldTex);

  // GPU motion lane (plan-gpu-motion-lane.md): compute programs + textures.
  r.convergedMotion?.dispose();

  if (r.edgesInst) {
    gl.deleteVertexArray(r.edgesInst.vao);
    gl.deleteVertexArray(r.edgesInst.vaoArrows);
    gl.deleteTexture(r.edgesInst.nodePosTex);
    gl.deleteTexture(r.edgesInst.nodeColorTex);
    gl.deleteTexture(r.edgesInst.edgeCtrlTex);
    gl.deleteProgram(r.edgesInst.program);
    gl.deleteProgram(r.edgesInst.programArrows);
  }

  if (r.programNodes) gl.deleteProgram(r.programNodes);
  if (r.programEdgesQuad) gl.deleteProgram(r.programEdgesQuad);
  if (r.programArrows) gl.deleteProgram(r.programArrows);

  // programEdges is currently an alias of programEdgesQuad in your code
  // If that changes later, it can be deleted explicitly here.

  try {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  } catch {
    // ignore
  }
}
