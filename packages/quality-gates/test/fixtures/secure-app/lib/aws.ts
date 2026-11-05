import { S3Client } from "@aws-sdk/client-s3";

// Credentials come from the environment (or the instance role), never from source.
export const s3 = new S3Client({ region: process.env.AWS_REGION ?? "eu-north-1" });
