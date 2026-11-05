import { z } from "zod";

/** Content model for the home page. Extend it (and the editor) when the site grows. */
export const SectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, "Use lowercase letters, digits and dashes"),
  heading: z.string().trim().min(1, "Heading is required").max(120),
  body: z.string().max(5000),
});

export const SiteContentSchema = z.object({
  hero: z.object({
    title: z.string().trim().min(1, "Title is required").max(120),
    lead: z.string().max(400),
    ctaLabel: z.string().max(40),
    ctaHref: z.string().max(300).regex(/^(\/|#|https:\/\/)/, "Link must start with /, # or https://"),
  }),
  sections: z.array(SectionSchema).max(30),
});

export type SiteContent = z.infer<typeof SiteContentSchema>;
export type Section = z.infer<typeof SectionSchema>;
