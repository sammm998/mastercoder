/**
 * "Molten" hero backdrop: a domain-warped fbm noise field in raw WebGL (no three.js; ~2 KB gz).
 * Renders at reduced resolution, pauses offscreen / in hidden tabs, and draws a single still frame
 * when the user prefers reduced motion. Colours come from the page's CSS tokens.
 */

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec2 m;uniform vec3 bg;uniform vec3 ac;uniform vec3 ink;uniform float dark;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 R=mat2(.8,.6,-.6,.8);for(int i=0;i<5;i++){v+=a*n(p);p=R*p*2.02;a*=.5;}return v;}
void main(){
 vec2 uv=gl_FragCoord.xy/r.xy;vec2 p=(gl_FragCoord.xy-.5*r.xy)/r.y;
 p+= (m-.5)*.12;
 float s=t*.035;
 vec2 q=vec2(fbm(p*1.6+s),fbm(p*1.6+vec2(5.2,1.3)-s));
 vec2 w=vec2(fbm(p*1.4+3.*q+vec2(1.7,9.2)+s*1.6),fbm(p*1.4+3.*q+vec2(8.3,2.8)-s));
 float f=fbm(p*1.2+3.5*w);
 float vein=smoothstep(.55,.95,f*f*1.6+.15*length(q));
 float glow=smoothstep(.35,1.,f);
 vec3 c=mix(bg,mix(bg,ink,.08),glow);
 c=mix(c,ac,vein*(.55+.35*dark));
 c+=ac*pow(vein,6.)*.35;
 float v=smoothstep(1.25,.25,length(uv-vec2(.72,.42))*1.4);
 c=mix(bg,c,v*.92);
 gl_FragColor=vec4(c,1.);
}`;

function rgb(css: string): [number, number, number] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = css;
  const hex = ctx.fillStyle;
  if (hex.startsWith("#") && hex.length === 7) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const m = hex.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [m[0]! / 255, m[1]! / 255, m[2]! / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

export interface EmberOptions {
  reducedMotion: boolean;
  onReady?: () => void;
}

export function startEmberField(canvas: HTMLCanvasElement, options: EmberOptions): () => void {
  let opts = options;
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false });
  if (!gl) return () => undefined;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return () => undefined;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => undefined;
  // Without a GPU (software rasterisers) animate nothing: draw one still frame.
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
  if (/swiftshader|llvmpipe|software/i.test(renderer)) opts = { ...opts, reducedMotion: true };
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uR = u("r"),
    uT = u("t"),
    uM = u("m"),
    uBg = u("bg"),
    uAc = u("ac"),
    uInk = u("ink"),
    uDark = u("dark");

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const bg = rgb(cs.getPropertyValue("--bg").trim() || "#0f0e0c");
    gl.uniform3fv(uBg, bg);
    gl.uniform3fv(uAc, rgb(cs.getPropertyValue("--accent").trim() || "#ff6a2b"));
    gl.uniform3fv(uInk, rgb(cs.getPropertyValue("--ink").trim() || "#f2ece2"));
    gl.uniform1f(uDark, bg[0] + bg[1] + bg[2] < 1.2 ? 1 : 0);
  };

  const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
  const resize = () => {
    const w = Math.max(1, Math.floor(canvas.clientWidth * scale));
    const h = Math.max(1, Math.floor(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uR, w, h);
  };

  let mouse: [number, number] = [0.5, 0.5];
  let target: [number, number] = [0.5, 0.5];
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    target = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  };

  let raf = 0;
  let visible = true;
  let running = false;
  const t0 = performance.now() - 40_000;
  let ready = false;
  let last = 0;
  const frame = (now: number) => {
    if (running && now - last < 32) {
      raf = requestAnimationFrame(frame);
      return;
    }
    last = now;
    mouse = [mouse[0] + (target[0] - mouse[0]) * 0.04, mouse[1] + (target[1] - mouse[1]) * 0.04];
    gl.uniform2f(uM, mouse[0], mouse[1]);
    gl.uniform1f(uT, (now - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!ready) {
      ready = true;
      opts.onReady?.();
    }
    if (running) raf = requestAnimationFrame(frame);
  };
  const play = () => {
    if (opts.reducedMotion) {
      resize();
      frame(t0 + 52_000);
      return;
    }
    if (running || !visible || document.hidden) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };
  const pause = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  readColors();
  resize();
  const ro = new ResizeObserver(() => {
    resize();
    if (opts.reducedMotion) frame(t0 + 52_000);
  });
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting;
    if (visible) play();
    else pause();
  });
  io.observe(canvas);
  const onVis = () => (document.hidden ? pause() : play());
  document.addEventListener("visibilitychange", onVis);
  const mo = new MutationObserver(() => {
    readColors();
    if (!running) frame(performance.now());
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    readColors();
    if (!running) frame(performance.now());
  };
  mq.addEventListener("change", onScheme);
  if (!opts.reducedMotion) window.addEventListener("pointermove", onMove, { passive: true });
  play();

  return () => {
    pause();
    ro.disconnect();
    io.disconnect();
    mo.disconnect();
    mq.removeEventListener("change", onScheme);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pointermove", onMove);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
