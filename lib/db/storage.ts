// Storage shim replacing Supabase Storage (MinIO). Objects are stored on a
// local disk volume; private buckets are served through an HMAC-signed URL
// route that mirrors Supabase's `/storage/v1/object/sign/...` shape, so the
// only code change in functions is none — they keep calling
// `supabase.storage.from(bucket).upload()/createSignedUrl()/getPublicUrl()`.

import { createHmac } from "crypto";
import { promises as fs } from "fs";
import path from "path";

const STORAGE_ROOT =
  process.env.STORAGE_ROOT || path.join(process.cwd(), ".storage");

/**
 * URLs handed out for stored objects are host-relative, so they work on
 * every host this app answers on (www., the bare domain and test hosts). Set
 * STORAGE_PUBLIC_URL only to force absolute URLs from a fixed origin.
 */
function publicBase(): string {
  return (process.env.STORAGE_PUBLIC_URL || "").replace(/\/+$/, "");
}

function signingSecret(): string {
  // Same order as before, so signed URLs already handed out keep working.
  const secret =
    process.env.STORAGE_SIGNING_SECRET ||
    process.env.JWT_SECRET ||
    process.env.AUTH_JWT_SECRET;
  if (secret) return secret;
  // A public default would let anyone sign a URL for a private object.
  if (process.env.NODE_ENV === "production") {
    throw new Error("STORAGE_SIGNING_SECRET (or JWT_SECRET) must be set in production");
  }
  return "storage-dev-secret";
}

/**
 * Buckets whose objects anyone may read through /storage/v1/object/public and
 * the image render route: the buckets that were public on Supabase. Only
 * `products` and `site-assets` hold files; the others are empty. Any other
 * bucket (`kyc-documents`) is private: signed URLs only.
 */
export const PUBLIC_BUCKETS = new Set(["products", "site-assets", "avatars", "blog", "media", "reviews"]);

const BUCKET_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  // Favicons and logos (admin settings uploads). SVG is served with a
  // sandbox CSP below, so script inside one never runs on this origin.
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const DOCUMENT_TYPES = new Set(["application/pdf"]);
/**
 * Product videos: Kinag's product form uploads MP4 / WebM / OGG / MOV / AVI
 * to the products bucket and the product page plays them in <video>, so they
 * are accepted and served inline with their own type (as Supabase did).
 */
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-msvideo"]);

/** Upload size caps. Images, product videos and PDFs may be uploaded. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
/** Supabase's default per-file limit; the largest video already stored is ~40 MB. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
/** The largest upload of any kind (for refusing a body before reading it). */
export const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_DOCUMENT_BYTES, MAX_VIDEO_BYTES);

function baseType(contentType: string | null | undefined): string {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

/** The largest upload accepted for a content type, or null when the type is not allowed at all. */
export function uploadLimitFor(contentType: string | null | undefined): number | null {
  const type = baseType(contentType);
  if (IMAGE_TYPES.has(type)) return MAX_IMAGE_BYTES;
  if (DOCUMENT_TYPES.has(type)) return MAX_DOCUMENT_BYTES;
  if (VIDEO_TYPES.has(type)) return MAX_VIDEO_BYTES;
  return null;
}

/**
 * The type to record for an upload: the uploader's type when it is an
 * allowed image or PDF type, else the type its file extension implies
 * (supabase-js sends Blobs without a type as application/octet-stream).
 * Null when neither is allowed.
 */
export function acceptedUploadType(objectPath: string, contentType: string | null | undefined): string | null {
  const given = baseType(contentType);
  if (uploadLimitFor(given) !== null) return given;
  const guessed = guessContentType(objectPath);
  return uploadLimitFor(guessed) !== null ? guessed : null;
}

/**
 * Response headers for serving a stored object.
 * - Raster images: inline with their own type and nosniff.
 * - SVG: inline, but under a sandbox CSP so script inside one never runs on
 *   this origin (also when opened directly).
 * - Product videos: inline with their own type, nosniff and the sandbox CSP
 *   (a media type never runs script).
 * - PDFs and everything else (unknown types): always
 *   a download (`Content-Disposition: attachment`) under a sandbox CSP, so
 *   nothing but an image ever renders on the store's origin.
 */
export function objectResponseHeaders(contentType: string): Record<string, string> {
  const type = baseType(contentType);
  const sandbox = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (IMAGE_TYPES.has(type)) {
    headers["Content-Type"] = type;
    if (type === "image/svg+xml") headers["Content-Security-Policy"] = sandbox;
    return headers;
  }
  headers["Content-Security-Policy"] = sandbox;
  if (VIDEO_TYPES.has(type)) {
    headers["Content-Type"] = type;
    return headers;
  }
  headers["Content-Disposition"] = "attachment";
  headers["Content-Type"] = DOCUMENT_TYPES.has(type) ? type : "application/octet-stream";
  return headers;
}

export function signObjectToken(bucket: string, objectPath: string, expEpoch: number): string {
  return createHmac("sha256", signingSecret())
    .update(`${bucket}/${objectPath}:${expEpoch}`)
    .digest("hex");
}

export function verifyObjectToken(
  bucket: string,
  objectPath: string,
  expEpoch: number,
  token: string
): boolean {
  if (!Number.isFinite(expEpoch) || Date.now() / 1000 > expEpoch) return false;
  const expected = signObjectToken(bucket, objectPath, expEpoch);
  // constant-time-ish compare
  if (expected.length !== token.length) return false;
  let out = 0;
  for (let i = 0; i < expected.length; i++) out |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return out === 0;
}

function safeJoin(bucket: string, objectPath: string): string {
  if (!BUCKET_RE.test(bucket)) throw new Error("Invalid bucket name");
  const clean = objectPath.replace(/^\/+/, "");
  // The .meta.json sidecar holds the stored type; it is never an object itself.
  if (!clean || clean.endsWith(".meta.json")) throw new Error("Invalid object path");
  const base = path.resolve(STORAGE_ROOT, bucket);
  const full = path.resolve(base, clean);
  // Compare with a trailing separator: "products-private" must not pass as "products".
  if (!full.startsWith(base + path.sep)) throw new Error("Path traversal blocked");
  return full;
}

/** Absolute disk path of a stored object (throws on path traversal). */
export function objectFilePath(bucket: string, objectPath: string): string {
  return safeJoin(bucket, objectPath);
}

/** Disk path for a resized variant, kept outside every bucket directory. */
export function renderCacheFilePath(
  bucket: string,
  objectPath: string,
  variant: string
): string {
  if (!BUCKET_RE.test(bucket)) throw new Error("Invalid bucket name");
  const clean = objectPath.replace(/^\/+/, "");
  const base = path.resolve(STORAGE_ROOT, ".render-cache", bucket);
  const full = path.resolve(base, `${clean}.${variant}`);
  if (!full.startsWith(base + path.sep)) throw new Error("Path traversal blocked");
  return full;
}

export async function readObject(
  bucket: string,
  objectPath: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const full = safeJoin(bucket, objectPath);
    const bytes = await fs.readFile(full);
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await fs.readFile(full + ".meta.json", "utf8"));
      if (meta.contentType) contentType = meta.contentType;
    } catch {
      contentType = guessContentType(objectPath);
    }
    // Older uploads stored without a real type: fall back to the extension.
    if (baseType(contentType) === "application/octet-stream") contentType = guessContentType(objectPath);
    return { bytes, contentType };
  } catch {
    return null;
  }
}

function guessContentType(p: string): string {
  const ext = p.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    ogg: "video/ogg",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    pdf: "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}

interface BucketApi {
  upload(
    objectPath: string,
    data: ArrayBuffer | Uint8Array | Buffer | Blob,
    opts?: { contentType?: string; upsert?: boolean }
  ): Promise<{ data: { path: string } | null; error: { message: string; statusCode?: string } | null }>;
  createSignedUrl(
    objectPath: string,
    expiresIn: number
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
  getPublicUrl(objectPath: string): { data: { publicUrl: string } };
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface StorageClient {
  from(bucket: string): BucketApi;
}

export function createStorageClient(): StorageClient {
  return {
    from(bucket: string): BucketApi {
      return {
        async upload(objectPath, data, opts) {
          try {
            const full = safeJoin(bucket, objectPath);
            await fs.mkdir(path.dirname(full), { recursive: true });
            let buf: Buffer;
            if (data instanceof Buffer) buf = data;
            else if (data instanceof Uint8Array) buf = Buffer.from(data);
            else if (data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(data));
            else if (typeof (data as Blob).arrayBuffer === "function") {
              buf = Buffer.from(new Uint8Array(await (data as Blob).arrayBuffer()));
            } else {
              buf = Buffer.from(data as any);
            }
            if (opts?.upsert) {
              await fs.writeFile(full, buf);
            } else {
              // Supabase semantics: without upsert an existing object is
              // never replaced ("wx" fails when the file exists).
              try {
                await fs.writeFile(full, buf, { flag: "wx" });
              } catch (e: any) {
                if (e?.code === "EEXIST") {
                  return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
                }
                throw e;
              }
            }
            if (opts?.contentType) {
              await fs.writeFile(
                full + ".meta.json",
                JSON.stringify({ contentType: opts.contentType })
              );
            }
            return { data: { path: objectPath }, error: null };
          } catch (e: any) {
            return { data: null, error: { message: e.message } };
          }
        },
        async createSignedUrl(objectPath, expiresIn) {
          const clean = objectPath.replace(/^\/+/, "");
          const exp = Math.floor(Date.now() / 1000) + (expiresIn || 3600);
          const token = signObjectToken(bucket, clean, exp);
          const url = `${publicBase()}/storage/v1/object/sign/${bucket}/${encodeURI(
            clean
          )}?token=${token}&exp=${exp}`;
          return { data: { signedUrl: url }, error: null };
        },
        getPublicUrl(objectPath) {
          const clean = objectPath.replace(/^\/+/, "");
          return {
            data: {
              publicUrl: `${publicBase()}/storage/v1/object/public/${bucket}/${encodeURI(clean)}`,
            },
          };
        },
        async remove(paths) {
          try {
            for (const p of paths) {
              const full = safeJoin(bucket, p);
              await fs.rm(full, { force: true });
              await fs.rm(full + ".meta.json", { force: true });
            }
            return { data: {}, error: null };
          } catch (e: any) {
            return { data: null, error: { message: e.message } };
          }
        },
      };
    },
  };
}
