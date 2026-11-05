import type { ReactNode } from "react";
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { ProductDemoProps, VideoTheme } from "../props.js";

function DeviceFrame({ device, theme, children, w, h }: { device: ProductDemoProps["device"]; theme: VideoTheme; children: ReactNode; w: number; h: number }) {
  if (device === "phone") {
    return (
      <div style={{ width: w, height: h, borderRadius: w * 0.12, background: "#05060a", padding: w * 0.035, boxShadow: "0 40px 80px rgba(0,0,0,0.45)" }}>
        <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: w * 0.09, overflow: "hidden", background: theme.colors.surface }}>
          {children}
          <div style={{ position: "absolute", top: w * 0.03, left: "50%", width: w * 0.3, height: w * 0.07, marginLeft: -w * 0.15, borderRadius: w, background: "#05060a" }} />
        </div>
      </div>
    );
  }
  const chrome = device === "browser";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: w, height: h, borderRadius: chrome ? 14 : 18, overflow: "hidden", background: theme.colors.surface, border: chrome ? `1px solid ${theme.colors.muted}55` : `${w * 0.018}px solid #0f1117`, boxShadow: "0 40px 90px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column" }}>
        {chrome ? (
          <div style={{ height: h * 0.07, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: theme.colors.surface, borderBottom: `1px solid ${theme.colors.muted}33`, flex: "none" }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
            ))}
            <span style={{ marginLeft: 16, flex: 1, height: h * 0.035, borderRadius: 8, background: `${theme.colors.muted}22` }} />
          </div>
        ) : null}
        <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>{children}</div>
      </div>
      {device === "laptop" ? <div style={{ width: w * 1.16, height: h * 0.05, background: "linear-gradient(#2a2d36, #15171d)", borderRadius: "0 0 24px 24px" }} /> : null}
    </div>
  );
}

function Shot({ src, caption, theme, device, index }: { src: string; caption: string; theme: VideoTheme; device: ProductDemoProps["device"]; index: number }) {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height, fps } = useVideoConfig();
  const t = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });
  const zoom = interpolate(t, [0, 1], [1.0, 1.18]);
  const panX = interpolate(t, [0, 1], index % 2 ? [3, -3] : [-3, 3]);
  const panY = interpolate(t, [0, 1], [0, -4]);
  const fade = interpolate(frame, [0, fps * 0.35, durationInFrames - fps * 0.3, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cap = interpolate(frame, [fps * 0.25, fps * 0.7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const phone = device === "phone";
  const fh = phone ? height * 0.78 : height * 0.66;
  const fw = phone ? fh * 0.5 : fh * 1.6;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: fade }}>
      <div style={{ transform: `translateY(${-height * 0.04}px)` }}>
        <DeviceFrame device={device} theme={theme} w={fw} h={fh}>
          <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${zoom}) translate(${panX}%, ${panY}%)` }} />
        </DeviceFrame>
      </div>
      <div style={{ position: "absolute", bottom: height * 0.06, left: width * 0.1, right: width * 0.1, textAlign: "center", opacity: cap, transform: `translateY(${(1 - cap) * 20}px)` }}>
        <span style={{ display: "inline-block", fontFamily: theme.fonts.body, fontSize: width * 0.022, color: theme.colors.text, background: `${theme.colors.surface}e6`, padding: `${width * 0.008}px ${width * 0.018}px`, borderRadius: 12, borderLeft: `4px solid ${theme.colors.accent}` }}>
          {caption}
        </span>
      </div>
    </AbsoluteFill>
  );
}

/** Screenshots inside a device frame with slow pan/zoom and captions. */
export function ProductDemo(props: ProductDemoProps) {
  const { durationInFrames, width } = useVideoConfig();
  const per = Math.max(1, Math.floor(durationInFrames / props.screenshots.length));
  const device = props.device ?? "browser";
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 30% 20%, ${props.theme.colors.accent}33, ${props.theme.colors.bg} 60%)` }}>
      <div style={{ position: "absolute", top: width * 0.025, left: width * 0.04, fontFamily: props.theme.fonts.display, fontSize: width * 0.022, color: props.theme.colors.text, fontWeight: 700 }}>
        {props.title}
      </div>
      {props.screenshots.map((s, i) => (
        <Sequence key={i} from={i * per} durationInFrames={i === props.screenshots.length - 1 ? durationInFrames - i * per : per}>
          <Shot src={s.src} caption={s.caption} theme={props.theme} device={device} index={i} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
