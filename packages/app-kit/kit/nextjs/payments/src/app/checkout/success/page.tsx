import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Thank you", robots: { index: false } };

export default function CheckoutSuccessPage() {
  return (
    <section className="hero container" aria-labelledby="thanks-title">
      <h1 id="thanks-title">Thank you!</h1>
      <p className="lead">Your payment was received. A receipt is on its way to your inbox.</p>
      <Link className="button" href="/">
        Back to home
      </Link>
    </section>
  );
}
