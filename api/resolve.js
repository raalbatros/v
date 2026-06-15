export const config = {
  runtime: "edge",
};

const DEFAULT_TTL = 55;
const MIN_TTL = 10;
const SAFETY_MARGIN = 10;
const STALE_AT = 20;
const SOFT_MS = 1200;
const HARD_MS = 4000;
const NEGATIVE_TTL = 5;
const JITTER_RATIO = 0.15;

const inFlight = new Map();

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("ID");

  if (!id || !/^[\w\s|:-]+$/.test(id)) {
    return new Response("Kullanim: ?ID=KANAL_ID", { status: 400 });
  }

  try {
    const streamUrl = await resolve(id);
    if (!streamUrl) return new Response("Stream bulunamadi", { status: 404 });

    return new Response(null, {
      status: 302,
      headers: {
        Location: streamUrl,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const isTimeout = err?.name === "TimeoutError";
    return new Response(isTimeout ? "Zaman asimi" : `Hata: ${err?.message || "Bilinmeyen hata"}`, {
      status: isTimeout ? 504 : 502,
    });
  }
}

async function resolve(id) {
  const { value, isStale } = await readCache(id);

  if (value && !isStale) return value === "NULL" ? null : value;

  if (value && isStale) {
    try {
      const fresh = await race(fetchDeduped(id), SOFT_MS);
      await writeCache(id, fresh);
      return fresh;
    } catch {
      fetchDeduped(id).then((u) => writeCache(id, u)).catch(() => {});
      return value === "NULL" ? null : value;
    }
  }

  const fresh = await fetchDeduped(id);
  await writeCache(id, fresh);
  return fresh;
}

async function fetchStreamUrl(id) {
  const res = await fetch("https://oha.to/oha-tv-resolver/mediaurl-resolve.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Vavoo/3.0.2 (Android)",
    },
    body: JSON.stringify({
      language: "tr",
      region: "DE",
      url: `https://www.oha.to/oha-tv/play/${id}`,
      clientVersion: "3.0.2",
    }),
    signal: AbortSignal.timeout(HARD_MS),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data[0]?.url : data?.url) || null;
}

function fetchDeduped(id) {
  if (inFlight.has(id)) return inFlight.get(id);

  const p = fetchStreamUrl(id).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

function race(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => {
        const e = new Error("soft");
        e.name = "TimeoutError";
        rej(e);
      }, ms)
    ),
  ]);
}

async function readCache(id) {
  const key = `https://cache.local/s/${encodeURIComponent(id)}`;
  const cached = await caches.default.match(key);
  if (!cached) return { value: null, isStale: false };

  const text = await cached.text();
  const age = parseInt(cached.headers.get("Age") || "0", 10);
  const max = parseInt((cached.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1] ?? "0", 10);

  return { value: text || null, isStale: (max - age) < STALE_AT };
}

async function writeCache(id, value) {
  const key = `https://cache.local/s/${encodeURIComponent(id)}`;
  const ttl = value ? computeTtl(value) : applyJitter(NEGATIVE_TTL);

  await caches.default.put(
    key,
    new Response(value ?? "NULL", {
      headers: {
        "Cache-Control": `public, max-age=${ttl}`,
        "Content-Type": "text/plain",
        "Date": new Date().toUTCString(),
      },
    })
  );
}

function computeTtl(url) {
  try {
    const u = new URL(url);
    const candidates = ["expire", "expires", "exp", "e", "token_expires", "expiry"];

    for (const key of candidates) {
      const raw = u.searchParams.get(key);
      if (!raw) continue;

      let ts = Number(raw);
      if (!Number.isFinite(ts)) continue;

      if (ts > 1e12) ts = Math.floor(ts / 1000);

      const nowSec = Math.floor(Date.now() / 1000);
      const remaining = ts - nowSec;

      if (remaining > 0 && remaining < 86400) {
        const ttl = remaining - SAFETY_MARGIN;
        return applyJitter(Math.max(MIN_TTL, ttl));
      }
    }
  } catch {}

  return applyJitter(DEFAULT_TTL);
}

function applyJitter(ttl) {
  const jitter = ttl * JITTER_RATIO * Math.random();
  return Math.max(MIN_TTL, Math.round(ttl + jitter));
}
