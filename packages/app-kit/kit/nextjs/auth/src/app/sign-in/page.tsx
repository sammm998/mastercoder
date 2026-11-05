import type { Metadata } from "next";
import { enabledSocialProviders } from "@/lib/auth";
import { safeReturnTo } from "@/lib/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <section className="container" aria-labelledby="signin-title" style={{ maxWidth: "28rem", paddingBlock: "var(--space-16)" }}>
      <h1 id="signin-title">Sign in</h1>
      <SignInForm providers={enabledSocialProviders} callbackURL={safeReturnTo(next)} />
    </section>
  );
}
