import type { AnyZodObject } from "zod";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { Explainer } from "./compositions/Explainer.js";
import { ProductDemo } from "./compositions/ProductDemo.js";
import { AnimatedText } from "./compositions/AnimatedText.js";
import { DEFAULT_VIDEO_THEME, type AnimatedTextProps, type ExplainerProps, type ProductDemoProps, type RenderSettings } from "./props.js";

type WithRender<P> = P & { render?: RenderSettings };

const DEFAULT_RENDER: RenderSettings = { durationSec: 6, fps: 30, width: 1280, height: 720 };

/** Size every composition from the `render` settings passed in inputProps. */
function metadata<P>(): CalculateMetadataFunction<WithRender<P>> {
  return ({ props }) => {
    const r = props.render ?? DEFAULT_RENDER;
    return { durationInFrames: Math.max(1, Math.round(r.durationSec * r.fps)), fps: r.fps, width: r.width, height: r.height };
  };
}

const base = { durationInFrames: 180, fps: 30, width: 1280, height: 720 };

export function RemotionRoot() {
  return (
    <>
      <Composition<AnyZodObject, WithRender<ExplainerProps>>
        id="Explainer"
        component={Explainer}
        {...base}
        defaultProps={{ theme: DEFAULT_VIDEO_THEME, title: "Title", subtitle: "Subtitle", sections: [{ heading: "Section", bullets: ["Point one", "Point two"] }] }}
        calculateMetadata={metadata<ExplainerProps>()}
      />
      <Composition<AnyZodObject, WithRender<ProductDemoProps>>
        id="ProductDemo"
        component={ProductDemo}
        {...base}
        defaultProps={{ theme: DEFAULT_VIDEO_THEME, title: "Product", device: "browser", screenshots: [{ src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", caption: "Caption" }] }}
        calculateMetadata={metadata<ProductDemoProps>()}
      />
      <Composition<AnyZodObject, WithRender<AnimatedTextProps>>
        id="AnimatedText"
        component={AnimatedText}
        {...base}
        defaultProps={{ theme: DEFAULT_VIDEO_THEME, lines: ["Line one", "Line two"], animation: "rise" }}
        calculateMetadata={metadata<AnimatedTextProps>()}
      />
    </>
  );
}
