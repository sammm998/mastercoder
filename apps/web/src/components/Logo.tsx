/** Forge mark: an anvil-cut square with an ember wedge struck out of the corner. */
export function LogoMark({ title }: { title?: string }) {
  return (
    <svg viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="2" y="2" width="28" height="28" rx="6" fill="currentColor" />
      <path d="M9 9h14v4.5H14v3h7v4.5h-7V23H9z" fill="var(--bg)" />
      <path d="M22 18.5 27 23.5V27h-3.5L18.5 22z" fill="var(--accent)" />
    </svg>
  );
}

export function Wordmark({ href = "/", label = "Forge" }: { href?: string; label?: string }) {
  return (
    <a href={href} className="wordmark" aria-label={label}>
      <LogoMark />
      <span aria-hidden="true">Forge</span>
    </a>
  );
}
