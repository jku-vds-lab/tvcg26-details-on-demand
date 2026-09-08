export function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label?: string
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const labelText = label ? ` (${label})` : "";
    throw new Error(`Shader compile failed${labelText}: ${info}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
  label?: string
): WebGLProgram {
  const program = gl.createProgram()!;
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource, label ? `${label} vertex` : undefined);
  const fragmentShader = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    fsSource,
    label ? `${label} fragment` : undefined
  );

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.deleteProgram(program);
    const labelText = label ? ` (${label})` : "";
    throw new Error(`Program link failed${labelText}: ${info}`);
  }

  gl.detachShader(program, vertexShader);
  gl.detachShader(program, fragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}