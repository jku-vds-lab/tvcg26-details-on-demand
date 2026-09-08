export function createNodesVAO(
  gl: WebGL2RenderingContext,
  programNodes: WebGLProgram,
  nodeBuffer: WebGLBuffer,
  nodeColorBuffer: WebGLBuffer,
  nodeOpacityFieldBuffer: WebGLBuffer,
  nodeEmphasisFieldBuffer: WebGLBuffer
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffer);
  const locPosition = gl.getAttribLocation(programNodes, "a_position");
  gl.enableVertexAttribArray(locPosition);
  gl.vertexAttribPointer(locPosition, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeColorBuffer);
  const locBaseColor = gl.getAttribLocation(programNodes, "a_baseColor");
  gl.enableVertexAttribArray(locBaseColor);
  gl.vertexAttribPointer(locBaseColor, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeOpacityFieldBuffer);
  const locOpacityField = gl.getAttribLocation(programNodes, "a_opacityField");
  gl.enableVertexAttribArray(locOpacityField);
  gl.vertexAttribPointer(locOpacityField, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, nodeEmphasisFieldBuffer);
  const locEmphasisField = gl.getAttribLocation(programNodes, "a_emphasisField");
  gl.enableVertexAttribArray(locEmphasisField);
  gl.vertexAttribPointer(locEmphasisField, 1, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);

  return vao;
}

export function createEdgesQuadVAO(
  gl: WebGL2RenderingContext,
  programEdgesQuad: WebGLProgram,
  edgeBuffer: WebGLBuffer,
  edgeIndexBuffer: WebGLBuffer
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeIndexBuffer);

  const stride = (2 + 2 + 2 + 3 + 3 + 1 + 1 + 1 + 1) * 4;
  let offset = 0;
  const attribs: [string, number][] = [
    ["a_start", 2],
    ["a_end", 2],
    ["a_corner", 2],
    ["a_colorStart", 3],
    ["a_colorEnd", 3],
    ["a_lastIndex", 1],
    ["a_nextIndex", 1],
    ["a_startPct", 1],
    ["a_endPct", 1],
  ];

  for (const [name, size] of attribs) {
    const loc = gl.getAttribLocation(programEdgesQuad, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    offset += size * 4;
  }

  gl.bindVertexArray(null);

  return vao;
}

/**
 * VAO for the instanced edge path (issue #315 phase B2): the only vertex
 * attribute is the static 4-corner TRIANGLE_STRIP quad; all per-instance
 * data is fetched from textures in edgeInstanced.vert (a real attribute is
 * used instead of gl_VertexID to avoid zero-attribute-draw driver quirks).
 */
export function createEdgesInstVAO(
  gl: WebGL2RenderingContext,
  programEdgesInst: WebGLProgram,
  cornerBuffer: WebGLBuffer
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  const locCorner = gl.getAttribLocation(programEdgesInst, "a_corner");
  gl.enableVertexAttribArray(locCorner);
  gl.vertexAttribPointer(locCorner, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);

  return vao;
}

/**
 * VAO for the instanced arrow path (issue #315 phase B2): only vertex
 * attribute is the static 3-vertex arrow triangle in local units; the edge
 * index is gl_InstanceID, everything else comes from the shared textures.
 */
export function createArrowsInstVAO(
  gl: WebGL2RenderingContext,
  programArrowsInst: WebGLProgram,
  offsetBuffer: WebGLBuffer
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, offsetBuffer);
  const locOffset = gl.getAttribLocation(programArrowsInst, "a_offset");
  gl.enableVertexAttribArray(locOffset);
  gl.vertexAttribPointer(locOffset, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);

  return vao;
}

export function createArrowsVAO(
  gl: WebGL2RenderingContext,
  programArrows: WebGLProgram,
  arrowBuffer: WebGLBuffer
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, arrowBuffer);
  const stride = (2 + 1 + 2 + 3 + 1 + 1 + 1) * 4;
  let offset = 0;
  const attribs: [string, number][] = [
    ["a_tipPosition", 2],
    ["a_rotation", 1],
    ["a_offset", 2],
    ["a_color", 3],
    ["a_lastIndex", 1],
    ["a_nextIndex", 1],
    ["a_endPct", 1],
  ];

  for (const [name, size] of attribs) {
    const loc = gl.getAttribLocation(programArrows, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    offset += size * 4;
  }

  gl.bindVertexArray(null);

  return vao;
}
