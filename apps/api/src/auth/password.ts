import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";

const PARAMS = { N: 16384, r: 8, p: 1 };

function scrypt(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, PARAMS);
  return ["scrypt", String(PARAMS.N), salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !n || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length, { ...PARAMS, N: Number(n) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Minimum policy: 10+ chars and at least two character classes. */
export function passwordProblems(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return "Use at least two of: lowercase, uppercase, digits, symbols";
  return null;
}
