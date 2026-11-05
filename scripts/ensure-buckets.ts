import { ensureBuckets } from "../packages/shared/src/adapters/s3.js";

if ((process.env.STORAGE_PROVIDER || "local") === "s3") {
  await ensureBuckets(
    {
      endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
      region: process.env.S3_REGION || "eu-central-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "forge",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "forgeforge",
    },
    [process.env.S3_BUCKET || "forge-artifacts", process.env.S3_RECORDINGS_BUCKET || "forge-recordings"],
  );
  console.log("buckets ready");
} else {
  console.log("STORAGE_PROVIDER is not s3; skipping buckets");
}
