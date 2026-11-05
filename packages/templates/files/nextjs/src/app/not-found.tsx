import Link from "next/link";

export default function NotFound() {
  return (
    <section className="hero container" aria-labelledby="nf-title">
      <h1 id="nf-title">Page not found</h1>
      <p className="lead">The page you are looking for does not exist.</p>
      <Link className="button" href="/">
        Back to home
      </Link>
    </section>
  );
}
