export const config = {
  runtime: "nodejs",
};

const DEFAULT_TTL = 55;
const MIN_TTL = 10;
const SAFETY_MARGIN = 10;
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
  // Cache devre dışı: direkt upstream
  const fresh = await fetchDeduped(id);
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
