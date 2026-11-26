/**
 * Simple in-memory rate limiter for API routes. Counts live in this one
 * container's memory (the app runs as a single container); a restart clears
 * them. For several instances this would need a shared store.
 *
 * Quick use in a route:
 *   import { isRateLimited, rateLimitedResponse, RATE_LIMITS } from '@/lib/rate-limit';
 *   if (isRateLimited(request, 'contact', RATE_LIMITS.form)) return rateLimitedResponse();
 * or the long form:
 *   checkRateLimit(`contact:${getClientIdentifier(request)}`, RATE_LIMITS.form).success
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up old entries periodically (every 5 minutes)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetTime < now) {
        rateLimitStore.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetIn: number; // seconds until reset
}

/**
 * Check if a request should be rate limited
 * @param identifier - Unique identifier for the client (IP, user ID, etc.)
 * @param config - Rate limit configuration
 * @returns Rate limit result
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;
  const key = identifier;
  
  let entry = rateLimitStore.get(key);
  
  // If no entry or window expired, create new entry
  if (!entry || entry.resetTime < now) {
    entry = {
      count: 1,
      resetTime: now + windowMs
    };
    rateLimitStore.set(key, entry);
    
    return {
      success: true,
      remaining: config.maxRequests - 1,
      resetIn: config.windowSeconds
    };
  }
  
  // Check if limit exceeded
  if (entry.count >= config.maxRequests) {
    const resetIn = Math.ceil((entry.resetTime - now) / 1000);
    return {
      success: false,
      remaining: 0,
      resetIn
    };
  }
  
  // Increment count
  entry.count++;
  rateLimitStore.set(key, entry);
  
  return {
    success: true,
    remaining: config.maxRequests - entry.count,
    resetIn: Math.ceil((entry.resetTime - now) / 1000)
  };
}

// ---- client IP -----------------------------------------------------------------
//
// Production path: browser → Cloudflare → Traefik (Coolify) → this app.
// Traefik sets X-Real-Ip to the address that connected to it and APPENDS
// that address to any X-Forwarded-For the client sent, so the trustworthy
// "direct peer" is X-Real-Ip (else the last X-Forwarded-For entry); earlier
// forwarded entries are whatever the client typed.
//
// When that peer is a Cloudflare edge, the real visitor is in
// CF-Connecting-IP (Cloudflare overwrites it). When the peer is NOT
// Cloudflare (someone talking to the origin directly), CF-Connecting-IP is
// client-supplied and ignored: the peer itself is the client.

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and
 * /ips-v6). Update when Cloudflare announces new ranges.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** An IPv4 address as a 32-bit number, or null. */
function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i]);
    if (part > 255) return null;
    n = n * 256 + part;
  }
  return n;
}

/** An IPv6 address as 8 16-bit groups, or null. Accepts an embedded IPv4 tail. */
function parseIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes its two hex groups.
  const lastColon = ip.lastIndexOf(':');
  const lastPart = ip.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const v4 = parseIpv4(lastPart);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s ? s.split(':') : []);
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8) return null;
  const groups: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

function inIpv4Range(ip: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseN = parseIpv4(base);
  const bits = Number(bitsRaw);
  if (baseN === null || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(baseN / size);
}

function inIpv6Range(ip: number[], cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseG = parseIpv6(base);
  const bits = Number(bitsRaw);
  if (!baseG || !(bits >= 0 && bits <= 128)) return false;
  let left = bits;
  for (let i = 0; i < 8 && left > 0; i++) {
    const take = Math.min(16, left);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((ip[i] & mask) !== (baseG[i] & mask)) return false;
    left -= take;
  }
  return true;
}

/** Normalise an address: trim, drop brackets/port, unwrap IPv4-mapped IPv6. */
export function normalizeIp(raw: string | null | undefined): string | null {
  let ip = String(raw || '').trim();
  if (!ip) return null;
  // [::1]:443 or 1.2.3.4:5678
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (parseIpv4(ip) !== null) return ip;
  if (parseIpv6(ip)) return ip.toLowerCase();
  return null;
}

/** Whether `ip` is inside any of the CIDR ranges (IPv4 and IPv6 mixed). */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  const clean = normalizeIp(ip);
  if (!clean) return false;
  const v4 = parseIpv4(clean);
  if (v4 !== null) return ranges.some((r) => !r.includes(':') && inIpv4Range(v4, r));
  const v6 = parseIpv6(clean);
  if (!v6) return false;
  return ranges.some((r) => r.includes(':') && inIpv6Range(v6, r));
}

/** Whether a connecting address belongs to Cloudflare's edge. */
export function isCloudflareIp(ip: string): boolean {
  const clean = normalizeIp(ip);
  if (!clean) return false;
  return parseIpv4(clean) !== null
    ? ipInRanges(clean, CLOUDFLARE_IPV4_RANGES)
    : ipInRanges(clean, CLOUDFLARE_IPV6_RANGES);
}

/** The address that connected to Traefik: X-Real-Ip, else the last X-Forwarded-For entry. */
function directPeer(headers: Headers): string | null {
  const realIp = normalizeIp(headers.get('x-real-ip'));
  if (realIp) return realIp;
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    const parts = forwardedFor.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return normalizeIp(parts[parts.length - 1]);
  }
  return null;
}

/**
 * The visitor's IP from request headers (see the notes above), or null when
 * no proxy header is present (local development).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const peer = directPeer(headers);
  if (peer && isCloudflareIp(peer)) {
    const cf = normalizeIp(headers.get('cf-connecting-ip'));
    if (cf) return cf;
  }
  return peer;
}

/**
 * Get client identifier from request (IP address)
 * @param request - The incoming request
 * @returns Client identifier string ('unknown' when no proxy header is present)
 */
export function getClientIdentifier(request: Request): string {
  return clientIpFromHeaders(request.headers) || 'unknown';
}

/**
 * One-line helper for routes: true when the caller is over `config` for
 * `bucket` (keyed by client IP, plus `extraKey` when given, e.g. an email or
 * order number). Use with RATE_LIMITS or your own { maxRequests, windowSeconds }.
 *
 *   if (isRateLimited(request, 'contact', RATE_LIMITS.form)) return tooMany();
 */
export function isRateLimited(
  request: Request,
  bucket: string,
  config: RateLimitConfig,
  extraKey?: string
): boolean {
  const key = `${bucket}:${getClientIdentifier(request)}${extraKey ? `:${extraKey.trim().toLowerCase()}` : ''}`;
  return !checkRateLimit(key, config).success;
}

/** A ready-made 429 JSON response with Retry-After. */
export function rateLimitedResponse(
  message = 'Too many requests. Please wait a minute and try again.',
  retryAfterSeconds = 60
): Response {
  return new Response(JSON.stringify({ success: false, error: message, message }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' },
  });
}

// ---- sign-in lockout (per email AND client IP) ---------------------------------
//
// Failures are counted for one email from one client IP. Counting per email
// alone let anyone lock any customer or admin out by typing wrong passwords
// for their address; now only the client making the attempts is locked.
// Pass the client IP (getClientIdentifier(request)); without one the email
// alone is used (old behaviour, for callers that have no request).

export const LOGIN_LOCKOUT = {
  /** Failed password attempts for one email from one IP before it is locked. */
  maxFailures: 10,
  /** Window the failures are counted in, and how long the lock lasts. */
  lockSeconds: 15 * 60,
};

const loginFailures = new Map<string, { count: number; resetTime: number }>();

function loginKey(email: string, ip?: string): string {
  const e = email.trim().toLowerCase();
  return ip ? `${e}|${ip}` : e;
}

/** Seconds left on a sign-in lock for this email (from this IP), or 0 when it may try again. */
export function loginLockRemaining(email: string, ip?: string): number {
  const entry = loginFailures.get(loginKey(email, ip));
  const now = Date.now();
  if (!entry || entry.resetTime <= now) return 0;
  if (entry.count < LOGIN_LOCKOUT.maxFailures) return 0;
  return Math.ceil((entry.resetTime - now) / 1000);
}

/** Count one wrong password for an email (from this IP). Only failures count toward the lock. */
export function recordLoginFailure(email: string, ip?: string): void {
  if (!email.trim()) return;
  const key = loginKey(email, ip);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || entry.resetTime <= now) {
    if (loginFailures.size > 10_000) {
      for (const [k, e] of loginFailures) if (e.resetTime <= now) loginFailures.delete(k);
    }
    loginFailures.set(key, { count: 1, resetTime: now + LOGIN_LOCKOUT.lockSeconds * 1000 });
    return;
  }
  entry.count++;
  // Reaching the limit starts a full lock period from the last failure.
  if (entry.count >= LOGIN_LOCKOUT.maxFailures) {
    entry.resetTime = now + LOGIN_LOCKOUT.lockSeconds * 1000;
  }
}

/**
 * A correct password clears the failure count: for that IP when one is
 * given, else every count for the email (any IP).
 */
export function clearLoginFailures(email: string, ip?: string): void {
  if (ip) {
    loginFailures.delete(loginKey(email, ip));
    return;
  }
  const e = email.trim().toLowerCase();
  loginFailures.delete(e);
  for (const k of loginFailures.keys()) if (k.startsWith(`${e}|`)) loginFailures.delete(k);
}

/**
 * Rate limit configurations for different endpoints
 */
export const RATE_LIMITS = {
  // Payment endpoints - strict limits
  payment: {
    maxRequests: 10,
    windowSeconds: 60 // 10 requests per minute
  },
  
  // Notification endpoints - moderate limits
  notification: {
    maxRequests: 20,
    windowSeconds: 60 // 20 requests per minute
  },
  
  /** Sign-in attempts to /auth/v1/token per client IP (shared office/mobile NAT gets headroom) */
  authLoginIp: {
    maxRequests: 30,
    windowSeconds: 60,
  },

  /** Sign-in attempts to /auth/v1/token per email address from one client IP */
  authLoginEmail: {
    maxRequests: 10,
    windowSeconds: 60,
  },

  // Callback endpoints - relaxed (webhooks from payment providers)
  callback: {
    maxRequests: 50,
    windowSeconds: 60 // 50 requests per minute
  },
  
  /** Public form posts (contact, returns, newsletter, tracking lookups) per client IP */
  form: {
    maxRequests: 10,
    windowSeconds: 60,
  },

  /** Order / request lookups by reference per client IP */
  lookup: {
    maxRequests: 30,
    windowSeconds: 60,
  },

  // General API - default limits
  default: {
    maxRequests: 100,
    windowSeconds: 60 // 100 requests per minute
  }
};
