/** Isomorphic base64 (browser, React Native, Node) without Buffer/btoa. */
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHA.length; i++) t[ALPHA.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // base64url
  t["_".charCodeAt(0)] = 63;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHA[(n >> 18) & 63]! + ALPHA[(n >> 12) & 63]! + ALPHA[(n >> 6) & 63]! + ALPHA[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHA[(n >> 18) & 63]! + ALPHA[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHA[(n >> 18) & 63]! + ALPHA[(n >> 12) & 63]! + ALPHA[(n >> 6) & 63]! + "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]/g, "");
  if (clean.length % 4 === 1) throw new Error("Invalid base64 length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? (LOOKUP[c] as number) : -1;
    if (v < 0) throw new Error("Invalid base64 character");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
