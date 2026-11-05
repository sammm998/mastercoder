import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore, PutOptions } from "../storage.js";

export interface S3Config {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** S3 / MinIO / any S3-compatible EU bucket. */
export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";
  private client: S3Client;
  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: Boolean(cfg.endpoint),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async put(key: string, body: Uint8Array | string, opts?: PutOptions) {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: buf, ContentType: opts?.contentType }));
    return { key, size: buf.byteLength };
  }
  async get(key: string): Promise<Uint8Array> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    if (!r.Body) throw new Error(`Empty object ${key}`);
    return r.Body.transformToByteArray();
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async list(prefix: string) {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.NextContinuationToken;
    } while (token);
    return out;
  }
  async url(key: string, expiresSec = 3600) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: expiresSec });
  }
}

/** Create buckets if missing (dev stacks: SeaweedFS / MinIO). */
export async function ensureBuckets(cfg: Omit<S3Config, "bucket">, buckets: string[]): Promise<void> {
  const { CreateBucketCommand, HeadBucketCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  for (const b of buckets) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: b }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: b }));
    }
  }
}
