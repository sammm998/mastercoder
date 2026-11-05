/**
 * The Scoutr crew: the lead plus the role agents that appear in `team.message` events. Names are brand
 * names (identical in every language); roles and descriptions come from the i18n catalogs (`crew.<id>.*`).
 */
export const CREW = ["scoutr", "plania", "pixel", "byggo", "vakt", "revy", "chatti", "mailo"] as const;
export type CrewId = (typeof CREW)[number];

export const CREW_NAME: Record<CrewId, string> = {
  scoutr: "Scoutr",
  plania: "Plania",
  pixel: "Pixel",
  byggo: "Byggo",
  vakt: "Vakt",
  revy: "Revy",
  chatti: "Chatti",
  mailo: "Mailo",
};

/** Each mascot's signature colour (used for avatar rings, name text tints and progress). */
export const CREW_COLOR: Record<CrewId, string> = {
  scoutr: "#ff9ec7",
  plania: "#c6e86b",
  pixel: "#ff8a6b",
  byggo: "#7ea6ff",
  vakt: "#ffd84d",
  revy: "#7fe0c3",
  chatti: "#c9a6ff",
  mailo: "#8fd3ff",
};

export function isCrewId(v: unknown): v is CrewId {
  return typeof v === "string" && (CREW as readonly string[]).includes(v);
}

export const avatarSrc = (id: CrewId) => `/brand/avatars/${id}.webp`;
