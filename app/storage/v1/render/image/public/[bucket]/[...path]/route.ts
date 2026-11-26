import { promises as fs } from "fs";
import path from "path";
import {
  objectFilePath,
  objectResponseHeaders,
  PUBLIC_BUCKETS,
  readObject,
  renderCacheFilePath,
} from "@/lib/db/storage";

// Mirrors Supabase's image transformation endpoint:
//   /storage/v1/render/image/public/<bucket>/<path>?width=480&quality=72
// Resized WebP variants are cached on the storage volume.
export const runtime = "nodejs";

const ALLOWED_WIDTHS = [320, 480, 640, 960, 1280, 1600];
const DEFAULT_QUALITY = 72;
const RESIZABLE = /\.(jpe?g|png|webp)$/i;

function pickWidth(raw: string | null): number {
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return 960;
  return ALLOWED_WIDTHS.find((w) => w >= requested) ?? ALLOWED_WIDTHS[ALLOWED_WIDTHS.length - 1];
}

function pickQuality(raw: string | null): number {
  const q = Number(raw);
  if (!Number.isFinite(q) || q <= 0) return DEFAULT_QUALITY;
  return Math.min(85, Math.max(40, Math.round(q)));
}

function imageResponse(bytes: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...objectResponseHeaders(contentType),
      "Cache-Control": "public, max-age=2592000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function serveOriginal(bucket: string, objectPath: string): Promise<Response> {
  const obj = await readObject(bucket, objectPath);
  if (!obj) {
    return new Response(JSON.stringify({ error: "Object not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return imageResponse(obj.bytes, obj.contentType);
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ bucket: string; path: string[] }> }
): Promise<Response> {
  const { bucket, path: segments } = await ctx.params;
  // Private buckets are only reachable through signed URLs.
  if (!PUBLIC_BUCKETS.has(bucket)) {
    return new Response(JSON.stringify({ error: "Object not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const objectPath = segments.map(decodeURIComponent).join("/");
  const { searchParams } = new URL(req.url);
  const width = pickWidth(searchParams.get("width"));
  const quality = pickQuality(searchParams.get("quality"));

  if (!RESIZABLE.test(objectPath)) {
    return serveOriginal(bucket, objectPath);
  }

  let sourceFile: string;
  let cacheFile: string;
  try {
    sourceFile = objectFilePath(bucket, objectPath);
    cacheFile = renderCacheFilePath(bucket, objectPath, `w${width}q${quality}.webp`);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceFile);
  } catch {
    return new Response(JSON.stringify({ error: "Object not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const cacheStat = await fs.stat(cacheFile);
    if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
      return imageResponse(await fs.readFile(cacheFile), "image/webp");
    }
  } catch {
    // not cached yet
  }

  try {
    const sharp = (await import("sharp")).default;
    const input = await fs.readFile(sourceFile);
    const output = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(width, width * 2, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();

    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, output);
    } catch (err) {
      console.warn("[storage render] cache write failed", cacheFile, err);
    }
    return imageResponse(output, "image/webp");
  } catch (err) {
    console.warn("[storage render] resize failed, serving original", objectPath, err);
    return serveOriginal(bucket, objectPath);
  }
}
