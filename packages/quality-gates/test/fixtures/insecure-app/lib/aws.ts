// INSECURE FIXTURE: hardcoded AWS credentials (the access key id is AWS's documented example value).
import { S3Client } from "@aws-sdk/client-s3";

const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const aws_secret_access_key = "Zq4tY8vB2nK6mR1xW9pL3sD7fH0jG5cA2eU8iO4k";

export const s3 = new S3Client({
  region: "eu-north-1",
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: aws_secret_access_key },
});
