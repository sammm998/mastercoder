/**
 * WebGL image distortion on hover. The real <img> (with alt text and intrinsic width/height reserving
 * space) is always rendered; on the first pointer enter, and only with a fine pointer, WebGL support and
 * no reduced-motion preference, a canvas overlay is created that ripples + RGB-splits the same image
 * around the pointer. The canvas is aria-hidden; keyboard focus on a wrapping link shows a CSS-only state.
 */
import { useEffect, useRef } from "react";
import { useCoarsePointer, usePrefersReducedMotion } from "../_shared/motion";

export interface DistortImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  /** Load eagerly (above the fold). */
  priority?: boolean;
}

const VERT = `attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; vUv.y = 1.0 - vUv.y; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `precision mediump float;
uniform sampler2D uTex; uniform vec2 uPointer; uniform float uHover; uniform float uTime; uniform vec2 uCover; varying vec2 vUv;
void main() {
  vec2 d = vUv - uPointer;
  float dist = length(d);
  float ripple = sin(dist * 38.0 - uTime * 5.0) * 0.012 * uHover * smoothstep(0.45, 0.0, dist);
  // Match CSS object-fit: cover so the canvas lines up with the <img> underneath.
  vec2 base = (vUv - 0.5) * uCover + 0.5;
  vec2 uv = base + normalize(d + 1e-5) * ripple;
  float shift = 0.006 * uHover;
  vec4 c = texture2D(uTex, uv);
  float r = texture2D(uTex, uv + vec2(shift, 0.0)).r;
  float b = texture2D(uTex, uv - vec2(shift, 0.0)).b;
  gl_FragColor = vec4(r, c.g, b, c.a);
}`;

interface GLState {
  gl: WebGLRenderingContext;
  uniforms: { pointer: WebGLUniformLocation | null; hover: WebGLUniformLocation | null; time: WebGLUniformLocation | null; cover: WebGLUniformLocation | null };
}

function initGL(canvas: HTMLCanvasElement, img: HTMLImageElement): GLState | null {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  } catch {
    return null; // cross-origin image without CORS: keep the plain <img>
  }
  return {
    gl,
    uniforms: {
      pointer: gl.getUniformLocation(prog, "uPointer"),
      hover: gl.getUniformLocation(prog, "uHover"),
      time: gl.getUniformLocation(prog, "uTime"),
      cover: gl.getUniformLocation(prog, "uCover"),
    },
  };
}

export function DistortImage({ src, alt, width, height, className = "", priority = false }: DistortImageProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  const enabled = !reducedMotion && !coarse;

  useEffect(() => {
    const el = wrap.current;
    const image = img.current;
    if (!el || !image || !enabled) return;
    let state: GLState | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let raf = 0;
    let hover = 0, target = 0, px = 0.5, py = 0.5;
    const start = performance.now();
    const draw = () => {
      if (!state || !canvas) return;
      hover += (target - hover) * 0.08;
      const { gl, uniforms } = state;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.pointer, px, py);
      gl.uniform1f(uniforms.hover, hover);
      gl.uniform1f(uniforms.time, (performance.now() - start) / 1000);
      const ca = canvas.width / canvas.height;
      const ia = image.naturalWidth / image.naturalHeight || ca;
      gl.uniform2f(uniforms.cover, ca > ia ? 1 : ca / ia, ca > ia ? ia / ca : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = target > 0 || hover > 0.002 ? requestAnimationFrame(draw) : 0;
      el.dataset.gl = hover > 0.002 || target > 0 ? "on" : "off";
    };
    const ensure = () => {
      if (state || !image.complete || image.naturalWidth === 0) return Boolean(state);
      canvas = document.createElement("canvas");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(image.clientWidth * dpr);
      canvas.height = Math.round(image.clientHeight * dpr);
      canvas.className = "distort__canvas";
      canvas.setAttribute("aria-hidden", "true");
      state = initGL(canvas, image);
      if (!state) return false;
      el.appendChild(canvas);
      return true;
    };
    const onEnter = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !ensure()) return;
      target = 1;
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      px = (e.clientX - r.left) / r.width;
      py = (e.clientY - r.top) / r.height;
    };
    const onLeave = () => {
      target = 0;
      if (!raf) raf = requestAnimationFrame(draw);
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      canvas?.remove();
      state?.gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [enabled, src]);

  return (
    <div ref={wrap} className={`distort ${className}`} data-pattern="image-distortion" data-motion={enabled ? "webgl-hover" : "static"} data-gl="off">
      <img ref={img} src={src} alt={alt} width={width} height={height} loading={priority ? "eager" : "lazy"} decoding="async" className="distort__img" />
    </div>
  );
}

export default DistortImage;
