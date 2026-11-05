import { site } from "./site";

export function App() {
  const year = new Date().getFullYear();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <nav className="container" aria-label="Main">
          <a className="brand" href="/">
            {site.name}
          </a>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
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
            Edit <code>src/App.tsx</code> to change this page. Colours, type and spacing come from{" "}
            <code>src/styles/tokens.css</code>.
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <div className="container">
          <p>
            © {year} {site.name}
          </p>
        </div>
      </footer>
    </>
  );
}
