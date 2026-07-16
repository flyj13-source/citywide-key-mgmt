import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Config } from './config';

// Thin wrapper over the S3-compatible object store (Cloudflare R2 by default;
// works unchanged against Backblaze B2 or AWS S3 — only the env vars differ).
// forcePathStyle is required for R2/B2 and custom endpoints.
export class BackupStore {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix;
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix.replace(/\/+$/, '')}/${k}` : k;
  }

  async put(k: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(k),
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async get(k: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(k) })
    );
    const chunks: Buffer[] = [];
    // Body is a Node Readable stream in the Node.js runtime.
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** List object keys under a prefix (relative to the configured base prefix),
   *  newest first, with size + last-modified. Handles pagination. */
  async list(subPrefix: string): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const full = this.key(subPrefix);
    const out: Array<{ key: string; size: number; lastModified: Date }> = [];
    let token: string | undefined;
    do {
      const res: any = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: full, ContinuationToken: token })
      );
      for (const o of res.Contents || []) {
        // Return keys WITHOUT the base prefix so callers work in relative space.
        const rel = this.prefix ? o.Key.slice(this.prefix.replace(/\/+$/, '').length + 1) : o.Key;
        out.push({ key: rel, size: o.Size || 0, lastModified: o.LastModified || new Date(0) });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    out.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return out;
  }

  async delete(k: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(k) }));
  }
}
