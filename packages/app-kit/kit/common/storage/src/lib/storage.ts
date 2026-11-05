// @forge-kit:server-only
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * S3-compatible object storage (AWS S3 in eu-*, Scaleway, Hetzner, MinIO, SeaweedFS ...).
 * Configure with S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.
 */
let client: S3Client | null = null;

function s3(): S3Client {
  if (client) return client;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  client = new S3Client({
    region: process.env.S3_REGION ?? "eu-central-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });
  return client;
}

function bucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET is not set");
  return b;
}

/** Reject keys that could escape a prefix or confuse signing. */
export function safeKey(key: string): string {
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\") || key.length > 1024) throw new Error(`Invalid object key: ${key}`);
  return key;
}

export async function putObject(key: string, body: Uint8Array | string, contentType = "application/octet-stream"): Promise<{ key: string; size: number }> {
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: safeKey(key), Body: data, ContentType: contentType }));
  return { key, size: data.byteLength };
}

export async function getObject(key: string): Promise<Uint8Array> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: safeKey(key) }));
  if (!res.Body) throw new Error(`Object ${key} has no body`);
  return res.Body.transformToByteArray();
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: safeKey(key) }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: safeKey(key) }));
}

/** Time-limited download URL (default 15 minutes). */
export function presignedDownloadUrl(key: string, expiresInSec = 900): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: safeKey(key) }), { expiresIn: expiresInSec });
}

/** Time-limited URL the browser can PUT a file to directly (default 15 minutes). */
export function presignedUploadUrl(key: string, contentType: string, expiresInSec = 900): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: safeKey(key), ContentType: contentType }), { expiresIn: expiresInSec });
}
