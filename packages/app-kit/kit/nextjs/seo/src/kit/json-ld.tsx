import { serializeJsonLd, type JsonLd as JsonLdData } from "@/lib/seo";

/** Inline schema.org JSON-LD: <JsonLd data={websiteJsonLd()} /> */
export function JsonLd({ data }: { data: JsonLdData | JsonLdData[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
