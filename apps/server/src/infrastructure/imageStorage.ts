import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import OSS from 'ali-oss';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';

export type StoredImage = { objectKey: string; publicUrl: string };

export interface ImageStorage {
  put(objectKey: string, body: Buffer, contentType?: string): Promise<StoredImage>;
  getBody(objectKey: string): Promise<Buffer>;
  /** 对象不存在返回 null，其他错误照抛。供 WebP 衍生图「先试后回落」使用（ADR-0068 §决策 2）。 */
  tryGetBody(objectKey: string): Promise<Buffer | null>;
  checkReady(): Promise<void>;
  checkReadAccess(): Promise<boolean>;
}

class LocalImageStorage implements ImageStorage {
  async put(objectKey: string, body: Buffer): Promise<StoredImage> {
    const filename = objectKey.replaceAll('/', '_');
    await fs.mkdir(config.catImagesDir, { recursive: true });
    await fs.writeFile(path.join(config.catImagesDir, filename), body);
    return { objectKey: filename, publicUrl: `/static/cats/${filename}` };
  }

  async getBody(objectKey: string) {
    return fs.readFile(path.join(config.catImagesDir, objectKey));
  }

  async tryGetBody(objectKey: string) {
    try {
      return await this.getBody(objectKey);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async checkReady() {
    await fs.mkdir(config.catImagesDir, { recursive: true });
    await fs.access(config.catImagesDir, constants.R_OK | constants.W_OK);
  }

  async checkReadAccess() {
    return true;
  }
}

class OssImageStorage implements ImageStorage {
  private readonly client = new OSS({
    endpoint: normalizeOssEndpoint(config.oss.endpoint),
    region: normalizeOssRegion(config.oss.region),
    bucket: config.oss.bucket,
    accessKeyId: config.oss.accessKeyId,
    accessKeySecret: config.oss.accessKeySecret,
    stsToken: config.oss.stsToken || undefined,
    secure: true,
  });
  private lastCheckAt = 0;

  async put(objectKey: string, body: Buffer, contentType = 'image/png'): Promise<StoredImage> {
    await this.client.put(objectKey, body, {
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': contentType },
    });
    return {
      objectKey,
      publicUrl: '',
    };
  }

  async getBody(objectKey: string) {
    const signedUrl = this.client.signatureUrl(objectKey, { expires: 300 });
    const response = await fetch(signedUrl);
    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }
    try {
      const result = await this.client.get(objectKey);
      return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
    } catch (directError) {
      const error = new Error(`OSS read failed (${response.status}) for ${objectKey}`);
      (error as { statusCode?: number }).statusCode = response.status;
      (error as { cause?: unknown }).cause = directError;
      throw error;
    }
  }

  async tryGetBody(objectKey: string) {
    try {
      return await this.getBody(objectKey);
    } catch (error) {
      const { statusCode, status, code } = error as { statusCode?: number; status?: number; code?: string };
      if ((statusCode ?? status) === 404 || code === 'NoSuchKey') return null;
      throw error;
    }
  }

  async checkReady() {
    if (Date.now() - this.lastCheckAt < 60_000) return;
    await this.client.getBucketInfo(config.oss.bucket);
    this.lastCheckAt = Date.now();
  }

  async checkReadAccess() {
    try {
      await this.client.head('.health/readiness-probe');
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      const code = (error as { code?: string }).code;
      if (status === 404 || code === 'NoSuchKey') return true;
      return false;
    }
  }
}

function normalizeOssEndpoint(endpoint: string) {
  return endpoint.replace('-internal.aliyuncs.com', '.aliyuncs.com');
}

function normalizeOssRegion(region: string) {
  return region.replace(/^oss-/, '');
}

/**
 * Cloudflare R2（ADR-0068 §决策 3）。走 S3 兼容 API，endpoint 由 account id 推导、region 固定 `auto`。
 *
 * 与 OSS 的差异：R2 没有 `getBucketInfo`，就绪检查用 `HeadBucket`；不用预签名 URL——
 * `getReadUrl` 全仓零调用点已删除，`getBody` 直接 `GetObject`（OSS 那套「预签名 fetch +
 * 回落 client.get」是历史绕法）。桶保持私有、不绑自定义域，浏览器永不直连（ADR-0020 第 3 条不变）。
 */
class R2ImageStorage implements ImageStorage {
  private readonly client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  private lastCheckAt = 0;
  /** 迁移期从 OSS 回落读到对象的次数——切换验收要求观察窗内为 0（ADR-0068 §决策 4）。 */
  private fallbackHits = 0;
  private readonly legacy = config.legacyOssFallback ? new OssImageStorage() : null;

  get fallbackHitCount() {
    return this.fallbackHits;
  }

  async put(objectKey: string, body: Buffer, contentType = 'image/png'): Promise<StoredImage> {
    await this.client.send(new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return { objectKey, publicUrl: '' };
  }

  private async fetchFromR2(objectKey: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: config.r2.bucket,
        Key: objectKey,
      }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw withStatusCode(error, objectKey);
    }
  }

  async getBody(objectKey: string) {
    const direct = await this.fetchFromR2(objectKey);
    if (direct) return direct;
    const fromLegacy = this.legacy ? await this.legacy.tryGetBody(objectKey) : null;
    if (fromLegacy) {
      // 只在 OSS 真的有、而 R2 没有时计数——这正是「迁移不完整」的信号。
      this.fallbackHits += 1;
      console.warn(`[imageStorage] R2 未命中、回落 OSS 读到 ${objectKey}（累计 ${this.fallbackHits} 次）——迁移不完整`);
      return fromLegacy;
    }
    const error = new Error(`R2 read failed (404) for ${objectKey}`);
    (error as { statusCode?: number }).statusCode = 404;
    throw error;
  }

  async tryGetBody(objectKey: string) {
    const direct = await this.fetchFromR2(objectKey);
    if (direct) return direct;
    const fromLegacy = this.legacy ? await this.legacy.tryGetBody(objectKey) : null;
    if (fromLegacy) {
      this.fallbackHits += 1;
      console.warn(`[imageStorage] R2 未命中、回落 OSS 读到 ${objectKey}（累计 ${this.fallbackHits} 次）——迁移不完整`);
    }
    return fromLegacy;
  }

  async checkReady() {
    if (Date.now() - this.lastCheckAt < 60_000) return;
    await this.client.send(new HeadBucketCommand({ Bucket: config.r2.bucket }));
    this.lastCheckAt = Date.now();
  }

  async checkReadAccess() {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: config.r2.bucket,
        Key: '.health/readiness-probe',
      }));
      return true;
    } catch (error) {
      // 探针对象不必存在；只有权限类错误才算不就绪（沿用 OSS 侧语义）。
      return isNotFound(error);
    }
  }
}

/** S3/R2 的「对象不存在」有两种形状：NoSuchKey（GetObject）与 NotFound（HeadObject）。 */
function isNotFound(error: unknown) {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

/** 保留 `statusCode` 契约：`routes/api.ts` 依赖它区分 403 与其他读失败。 */
function withStatusCode(error: unknown, objectKey: string) {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 502;
  const wrapped = new Error(`R2 read failed (${status}) for ${objectKey}`);
  (wrapped as { statusCode?: number }).statusCode = status;
  (wrapped as { cause?: unknown }).cause = error;
  return wrapped;
}

function createImageStorage(): ImageStorage {
  if (config.storageDriver === 'r2') return new R2ImageStorage();
  if (config.storageDriver === 'oss') return new OssImageStorage();
  return new LocalImageStorage();
}

export const imageStorage: ImageStorage = createImageStorage();

/** 迁移期回落命中数；非 R2 driver 返回 null（`/readyz` 用它做切换验收）。 */
export function storageFallbackHits(): number | null {
  return imageStorage instanceof R2ImageStorage ? imageStorage.fallbackHitCount : null;
}
