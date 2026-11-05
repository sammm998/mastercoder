/** Forge mark: a bold F cut from a dark block, with an ember spark. */
export function LogoMark({ title }: { title?: string }) {
  return (
    <svg viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="2" y="2" width="28" height="28" rx="6" fill="currentColor" />
      <path d="M10 8h13v4h-8.5v3H21v4h-6.5v5H10z" fill="var(--bg)" />
      <path d="M24 17.5l1.4 3.1 3.1 1.4-3.1 1.4-1.4 3.1-1.4-3.1-3.1-1.4 3.1-1.4z" fill="var(--accent)" />
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
