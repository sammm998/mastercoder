import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { motionDuration, prefersReducedMotion } from "../src/lib/motion";

describe("App", () => {
  it("renders landmarks and the main heading", () => {
    render(<App />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
  });
});

describe("motion", () => {
  it("honours prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    expect(prefersReducedMotion()).toBe(true);
    expect(motionDuration(300)).toBe(0);
    expect(motionDuration(300, false)).toBe(300);
    vi.unstubAllGlobals();
  });
});
