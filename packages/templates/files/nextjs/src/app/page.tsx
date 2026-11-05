import { site } from "@/lib/site";

export default function HomePage() {
  return (
    <>
      <section className="hero container reveal" aria-labelledby="hero-title">
        <h1 id="hero-title">{site.name}</h1>
        <p className="lead">{site.description}</p>
        <a className="button" href="#get-started">
          Get started
        </a>
      </section>
      <section id="get-started" className="container" aria-labelledby="start-title">
        <h2 id="start-title">Get started</h2>
        <p>
          Edit <code>src/app/page.tsx</code> to change this page. Colours, type and spacing come from{" "}
          <code>src/styles/tokens.css</code>.
        </p>
      </section>
    </>
  );
}
