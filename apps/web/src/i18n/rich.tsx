import { Fragment, type ReactNode } from "react";

/** Marker to pass as a variable, e.g. t("auth.terms", { terms: slot("terms") }). */
export const slot = (name: string) => `[[${name}]]`;

/** Replace [[name]] slots in a translated string with React nodes (links, emphasis). */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/\[\[(\w+)\]\]/);
  return parts.map((p, i) => <Fragment key={i}>{i % 2 === 1 ? (nodes[p] ?? p) : p}</Fragment>);
}
