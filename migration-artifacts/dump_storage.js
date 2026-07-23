#!/usr/bin/env node
/**
 * Download storage objects for kinagventures into migration-artifacts/storage.
 * Usage: node migration-artifacts/dump_storage.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
function loadEnv() {
  const env = { ...process.env };
  for (const name of [".env.local", "env.local", ".env"]) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!(k in env) || !env[k]) env[k] = v;
    }
  }
  return env;
}

const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const OUT = path.join(__dirname, "storage");
const BUCKETS = ["avatars", "blog", "media", "products", "reviews", "site-assets"];

async function listAll(bucket, prefix = "") {
  const res = await fetch(`${URL_}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix, limit: 1000 }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function download(bucket, objectPath) {
  const res = await fetch(
    `${URL_}/storage/v1/object/${bucket}/${objectPath}`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
  );
  if (!res.ok) {
    console.log(`  FAIL ${bucket}/${objectPath}: ${res.status}`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(OUT, bucket, objectPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const ct = res.headers.get("content-type") || "application/octet-stream";
  fs.writeFileSync(dest + ".meta.json", JSON.stringify({ contentType: ct }));
  console.log(`  ok ${bucket}/${objectPath} (${buf.length}b)`);
}

async function walk(bucket, prefix = "") {
  const items = await listAll(bucket, prefix);
  if (items === null) {
    console.log(`bucket ${bucket}: not found / inaccessible`);
    return;
  }
  for (const item of items) {
    const name = item.name;
    if (!name) continue;
    const full = prefix ? `${prefix}/${name}` : name;
    if (item.id === null || item.metadata === null) {
      await walk(bucket, full);
    } else {
      await download(bucket, full);
    }
  }
}

async function main() {
  if (!URL_ || !KEY) throw new Error("Missing Supabase env");
  fs.mkdirSync(OUT, { recursive: true });
  for (const b of BUCKETS) {
    console.log(`bucket ${b}`);
    await walk(b);
  }
  console.log("DONE", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
