/* Static brand assets from /public, rendered as plain <img> (no image optimiser needed for small webp files). */

/** Scoutr mark: the lead mascot as a round avatar (used where only an icon fits, e.g. the collapsed sidebar). */
export function LogoMark({ title, size = 28 }: { title?: string; size?: number }) {
  return <img src="/brand/avatars/scoutr.webp" width={size} height={size} alt={title ?? ""} aria-hidden={title ? undefined : true} className="logo-mark" decoding="async" />;
}

/** The Scoutr wordmark (brand artwork). Dark ink on light; inverted for the dark theme via a token. */
export function Wordmark({ href = "/", label = "Scoutr" }: { href?: string; label?: string }) {
  return (
    <a href={href} className="wordmark" aria-label={label}>
      <img src="/brand/scoutr-logo.webp" width={96} height={32} alt="" className="wordmark-img" decoding="async" />
    </a>
  );
}
