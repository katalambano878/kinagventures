#!/usr/bin/env node
/**
 * Fresh full dump from live Supabase (kinagventures).
 * Usage: node migration-artifacts/dump_fresh.js [outdir]
 */
const fs = require("fs");
const path = require("path");

const OUT = process.argv[2] || "migration-artifacts/dumps";
const root = path.join(__dirname, "..");

function loadEnv() {
  const env = { ...process.env };
  for (const name of ["env.local", ".env.local", ".env"]) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const i = trimmed.indexOf("=");
      if (i <= 0) continue;
      const k = trimmed.slice(0, i).trim();
      let v = trimmed.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(k in env) || !env[k]) env[k] = v;
    }
  }
  return env;
}

const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

const TABLES = [
  "addresses",
  "ai_memory",
  "audit_logs",
  "banners",
  "blog_posts",
  "cart_items",
  "categories",
  "chat_conversations",
  "cms_content",
  "contact_submissions",
  "coupons",
  "customers",
  "navigation_menus",
  "navigation_items",
  "notifications",
  "order_items",
  "order_status_history",
  "orders",
  "pages",
  "preorders",
  "product_images",
  "product_variants",
  "products",
  "profiles",
  "return_items",
  "return_requests",
  "review_images",
  "reviews",
  "shipping_fees",
  "site_settings",
  "store_modules",
  "store_settings",
  "support_messages",
  "support_tickets",
  "wa_agent_webhook_config",
  "wishlist_items",
];

async function dumpTable(t) {
  const rows = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const res = await fetch(`${URL_}/rest/v1/${t}?select=*`, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Range: `${from}-${from + page - 1}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`  ${t}: HTTP ${res.status} ${body.slice(0, 120)}`);
      return null;
    }
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }
  return rows;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const inventory = { dumpedAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const rows = await dumpTable(t);
    if (rows === null) continue;
    fs.writeFileSync(path.join(OUT, `${t}.json`), JSON.stringify(rows, null, 1));
    inventory.tables[t] = rows.length;
    console.log(`${t}: ${rows.length}`);
  }
  fs.writeFileSync(path.join(OUT, "_inventory.json"), JSON.stringify(inventory, null, 2));
  console.log("DONE", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
