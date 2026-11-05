# 0002 — SeaweedFS as local S3

**Decision:** docker-compose uses SeaweedFS's S3 gateway instead of MinIO.

**Why:** MinIO images (`minio/minio`, `minio/mc`) are no longer pullable from Docker Hub/quay in our
environment. SeaweedFS is S3-compatible (path-style, SigV4) and Apache-2.0. The app only talks the S3 API
(`S3ObjectStore`), so swapping to MinIO, AWS S3 (eu-central-1) or Hetzner/Scaleway object storage is config.
Buckets are created on boot with `ensureBuckets()`.
