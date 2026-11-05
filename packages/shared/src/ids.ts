import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Prefixed, URL-safe, sortable-ish id: `${prefix}_${time36}${random}` */
export function newId(prefix: string, randomLen = 12): string {
  const bytes = randomBytes(randomLen);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
