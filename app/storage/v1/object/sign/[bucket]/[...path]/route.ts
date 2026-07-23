import { readObject, verifyObjectToken } from "@/lib/db/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ bucket: string; path: string[] }> }
): Promise<Response> {
  const { bucket, path } = await ctx.params;
  const objectPath = path.map(decodeURIComponent).join("/");
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const exp = Number(url.searchParams.get("exp") || 0);

  if (!verifyObjectToken(bucket, objectPath, exp, token)) {
    return new Response(JSON.stringify({ error: "Invalid or expired signature" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const obj = await readObject(bucket, objectPath);
  if (!obj) {
    return new Response(JSON.stringify({ error: "Object not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(new Uint8Array(obj.bytes), {
    status: 200,
    headers: {
      "Content-Type": obj.contentType,
      "Cache-Control": "private, max-age=300",
    },
  });
}
