/**
 * The hero "planet horizon": a dark sphere whose rim is lit by blue and amber light blooming upwards, with
 * faint vertical light streaks. Pure CSS gradients + blur (no images, no JS), so it is part of first paint,
 * costs nothing on the main thread and is static under prefers-reduced-motion.
 */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="aurora-bloom" />
      <div className="aurora-rays" />
      <div className="aurora-streaks" />
      <div className="aurora-rim" />
      <div className="aurora-planet" />
    </div>
  );
}
