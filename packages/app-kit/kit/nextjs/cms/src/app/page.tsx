import { getSiteContent } from "@/lib/cms/store";

// Content is edited at /admin and read from the database on each request.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const content = await getSiteContent();
  return (
    <>
      <section className="hero container reveal" aria-labelledby="hero-title">
        <h1 id="hero-title">{content.hero.title}</h1>
        {content.hero.lead && <p className="lead">{content.hero.lead}</p>}
        {content.hero.ctaLabel && (
          <a className="button" href={content.hero.ctaHref}>
            {content.hero.ctaLabel}
          </a>
        )}
      </section>
      {content.sections.map((s) => (
        <section key={s.id} id={s.id} className="container" aria-labelledby={`${s.id}-title`}>
          <h2 id={`${s.id}-title`}>{s.heading}</h2>
          {s.body.split(/\n{2,}/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      ))}
    </>
  );
}
