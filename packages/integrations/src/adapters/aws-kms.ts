import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { ForgeError } from "@forge/shared";
import type { KeyProvider } from "../vault.js";

export interface AwsKmsOptions {
  /** KMS key id / ARN / alias used as KEK (symmetric, ENCRYPT_DECRYPT). */
  keyId: string;
  /** EU by default (data residency). */
  region?: string;
  client?: KMSClient;
}

/**
 * KEK in AWS KMS: DEKs are wrapped with kms:Encrypt and unwrapped with kms:Decrypt, both bound to an
 * EncryptionContext of workspace/project/secret name (logged in CloudTrail, required to decrypt).
 * Credentials come from the standard AWS provider chain (env, IRSA, instance profile).
 */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = "aws-kms";
  readonly keyId: string;
  private readonly client: KMSClient;

  constructor(opts: AwsKmsOptions) {
    if (!opts.keyId) throw new ForgeError("BAD_INPUT", "VAULT_KMS_KEY_ID is required for VAULT_KEY_PROVIDER=kms");
    this.keyId = opts.keyId;
    this.client = opts.client ?? new KMSClient({ region: opts.region ?? "eu-central-1" });
  }

  async wrap(dek: Buffer, context: Record<string, string>): Promise<string> {
    const r = await this.client.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: dek, EncryptionContext: context }));
    if (!r.CiphertextBlob) throw new ForgeError("PROVIDER_ERROR", "KMS Encrypt returned no ciphertext");
    return Buffer.from(r.CiphertextBlob).toString("base64");
  }

  async unwrap(wrapped: string, context: Record<string, string>): Promise<Buffer> {
    try {
      const r = await this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: Buffer.from(wrapped, "base64"), EncryptionContext: context }));
      if (!r.Plaintext) throw new Error("no plaintext");
      return Buffer.from(r.Plaintext);
    } catch (e) {
      throw new ForgeError("FORBIDDEN", `KMS Decrypt failed: ${(e as Error).name || (e as Error).message}`);
    }
  }
}
