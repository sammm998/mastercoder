/** Minimal ustar writer (directories + regular files) used to seed containers via `docker cp -a -`. */
export interface TarEntry {
  name: string;
  type: "file" | "dir";
  mode?: number;
  uid?: number;
  gid?: number;
  content?: Uint8Array | string;
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  let name = e.name.replace(/^\/+/, "");
  if (e.type === "dir" && !name.endsWith("/")) name += "/";
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const idx = name.lastIndexOf("/", name.length - 2);
    prefix = name.slice(0, idx);
    name = name.slice(idx + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`tar path too long: ${e.name}`);
  }
  h.write(name, 0, 100, "utf8");
  h.write(octal(e.mode ?? (e.type === "dir" ? 0o755 : 0o644), 8), 100, 8, "ascii");
  h.write(octal(e.uid ?? 0, 8), 108, 8, "ascii");
  h.write(octal(e.gid ?? 0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(e.type === "dir" ? "5" : "0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

export function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = e.type === "file" ? Buffer.from(e.content ?? "") : Buffer.alloc(0);
    parts.push(header(e, body.length));
    if (body.length) {
      parts.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}
