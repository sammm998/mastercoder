"use client";

import { useEffect } from "react";

/**
 * Landing-page motion that works in every browser: scroll reveals (staggered per group), hero parallax
 * for the floating mascots and the product mock, and a scroll-progress value for CSS. Browsers with
 * CSS scroll-driven animations still get them; this adds the same effect elsewhere (e.g. Safari).
 * Everything is skipped under prefers-reduced-motion.
 */
export function ScrollFx() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    root.classList.add("fx-js");
    const items = [...document.querySelectorAll<HTMLElement>(".landing .reveal, .landing .section-head-row, .landing .bento-card, .landing .crew-grid > li, .landing .step")];
    // Stagger siblings that enter together.
    const groups = new Map<Element | null, HTMLElement[]>();
    for (const el of items) {
      const g = groups.get(el.parentElement) ?? [];
      g.push(el);
      groups.set(el.parentElement, g);
    }
    for (const g of groups.values()) g.forEach((el, i) => el.style.setProperty("--fx-delay", `${Math.min(i, 6) * 80}ms`));
    for (const el of items) el.classList.add("fx-item");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add("fx-in");
            io.unobserve(e.target);
          }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    items.forEach((el) => io.observe(el));

    const floaters = [...document.querySelectorAll<HTMLElement>(".landing .floater")];
    const mock = document.querySelector<HTMLElement>(".landing .mock-window");
    const mascot = document.querySelector<HTMLElement>(".landing .hero-mascot");
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = window.scrollY;
        const vh = window.innerHeight;
        root.style.setProperty("--scroll", String(Math.min(1, y / (document.body.scrollHeight - vh || 1))));
        if (y > vh * 1.6) return;
        floaters.forEach((f, i) => (f.style.translate = `0 ${-(y * (0.12 + (i % 3) * 0.07)).toFixed(1)}px`));
        if (mascot) mascot.style.translate = `0 ${(y * 0.18).toFixed(1)}px`;
        if (mock) {
          const t = Math.min(1, y / (vh * 0.9));
          mock.style.transform = `perspective(1400px) rotateX(${(12 * (1 - t)).toFixed(2)}deg) scale(${(0.94 + 0.06 * t).toFixed(3)})`;
        }
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      root.classList.remove("fx-js");
    };
  }, []);
  return null;
}
