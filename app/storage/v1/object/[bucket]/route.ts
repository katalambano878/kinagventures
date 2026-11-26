import { NextRequest, NextResponse } from "next/server";
import { createStorageClient } from "@/lib/db/storage";
import { isPlainPostgres } from "@/lib/db/mode";
import { authorizeStorageWrite } from "@/lib/db/storage-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** supabase-js remove(): DELETE /storage/v1/object/{bucket} with {"prefixes": [...]} */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ bucket: string }> }) {
  if (!isPlainPostgres()) {
    return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 503 });
  }
  const { bucket } = await ctx.params;
  const denied = await authorizeStorageWrite(req, bucket);
  if (denied) return denied;

  let prefixes: unknown;
  try {
    prefixes = (await req.json())?.prefixes;
  } catch {
    prefixes = null;
  }
  if (!Array.isArray(prefixes) || !prefixes.every((p) => typeof p === "string")) {
    return NextResponse.json({ error: "prefixes must be an array of object paths" }, { status: 400 });
  }

  const { error } = await createStorageClient().from(bucket).remove(prefixes);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(prefixes.map((name) => ({ name, bucket_id: bucket })));
}
