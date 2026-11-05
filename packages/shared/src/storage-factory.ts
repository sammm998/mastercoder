import { env, selectAdapter } from "./env.js";
import { LocalObjectStore, type ObjectStore } from "./storage.js";

export async function createObjectStore(bucketEnv = "S3_BUCKET"): Promise<ObjectStore> {
  const provider = (process.env.STORAGE_PROVIDER || "local").toLowerCase();
  if (provider === "s3") {
    const { S3ObjectStore } = await import("./adapters/s3.js");
    return new S3ObjectStore({
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: env("S3_REGION", "eu-central-1"),
      accessKeyId: env("S3_ACCESS_KEY_ID"),
      secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
      bucket: env(bucketEnv, "forge-artifacts"),
    });
  }
  return selectAdapter<ObjectStore>("STORAGE_PROVIDER", {
    local: () => new LocalObjectStore(env("LOCAL_STORAGE_DIR", ".data/storage")),
    mock: () => new LocalObjectStore(env("LOCAL_STORAGE_DIR", ".data/storage-mock")),
  }, "local").instance;
}
