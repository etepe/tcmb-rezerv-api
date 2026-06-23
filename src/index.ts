// M-003 api-worker — HTTP route'ları, KV cache, CORS, tanımlı hata yanıtları.
// Faz 1: GET /api/weekly (C-001 haftalık alt kümesi).
// Faz 2: + GET /api/summary (haftalık + günlük nowcast + NIR; C-001).

import type {
  ApiError,
  ApiErrorCode,
  SummaryMeta,
  SummaryResponse,
  WeeklyMeta,
  WeeklyResponse,
} from "./types.ts";
import { EvdsError, fetchSeries } from "./evds-client.ts";
import { computeDailyNowcast, computeWeekly, EngineError, weeklyMeta } from "./reserve-engine.ts";

export interface Env {
  /** EVDS anahtarı — `wrangler secret put TCMB_EVDS_KEY`. Asla yanıtta/logda. */
  TCMB_EVDS_KEY: string;
  /** KV cache namespace. */
  REZERV_CACHE: KVNamespace;
  /** Haftalık cache TTL (saniye, string). Varsayılan 21600 (~6 sa). */
  WEEKLY_TTL?: string;
  /** Günlük (summary) cache TTL (saniye, string). Varsayılan 3600 (~1 sa). */
  DAILY_TTL?: string;
  /** Varsayılan haftalık başlangıç (dd-mm-yyyy). */
  DEFAULT_WEEKLY_START?: string;
}

// Haftalık brüt rezerv seri kodları.
const WEEKLY_CODES = ["TP.AB.TOPLAM", "TP.AB.C2", "TP.AB.C1"];
// Günlük analitik bilanço seri kodları (İŞ GÜNÜ): Dış Varlık / Döviz Yük. / USD kuru.
const DAILY_CODES = ["TP.AB.A02", "TP.AB.A10", "TP.DK.USD.A.YTL"];
const DEFAULT_WEEKLY_TTL = 21600; // ~6 saat
const DEFAULT_DAILY_TTL = 3600; //   ~1 saat (summary; günlük veri daha sık tazelenir)
const FALLBACK_START = "01-10-2025";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Hata kodu -> HTTP durum kodu (tanımlı hatalar 5xx). */
function statusFor(code: ApiErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "not_found":
      return 404;
    case "upstream_timeout":
      return 504;
    case "evds_unavailable":
    case "evds_auth_failed":
    case "non_json_response":
    case "empty_series":
    case "no_anchor":
    case "anchor_not_in_daily":
      return 502;
    default:
      return 500;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function errorResponse(code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: code, message };
  return json(body, statusFor(code));
}

/** `dd-mm-yyyy` doğrulama (kabaca; EVDS bu formatı bekler). */
function isValidDdMmYyyy(s: string): boolean {
  return /^\d{2}-\d{2}-\d{4}$/.test(s);
}

function todayDdMmYyyy(): string {
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = now.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/** ISO `yyyy-mm-dd` -> EVDS `dd-mm-yyyy`. Eşleşmezse girdiyi aynen döner. */
function isoToDdMmYyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

async function handleWeekly(url: URL, env: Env): Promise<Response> {
  const start = url.searchParams.get("start") ?? env.DEFAULT_WEEKLY_START ?? FALLBACK_START;
  const end = url.searchParams.get("end") ?? todayDdMmYyyy();

  if (!isValidDdMmYyyy(start) || !isValidDdMmYyyy(end)) {
    return errorResponse("bad_request", "start/end `dd-mm-yyyy` olmalı.");
  }

  const ttl = Number(env.WEEKLY_TTL ?? "") || DEFAULT_WEEKLY_TTL;
  const cacheKey = `weekly:${start}:${end}`;

  // 1) KV oku (cache hit).
  const cached = await env.REZERV_CACHE.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as WeeklyResponse;
    parsed.meta.cached = true;
    return json(parsed, 200);
  }

  // 2) Miss: EVDS'ten çek -> hesapla.
  const rows = await fetchSeries(WEEKLY_CODES, start, end, env.TCMB_EVDS_KEY);
  const weekly = computeWeekly(rows);
  const computed = weeklyMeta(weekly);

  const meta: WeeklyMeta = {
    ...computed,
    start,
    end,
    updatedAt: new Date().toISOString(),
    unit: "milyar USD",
    source: "TCMB EVDS",
    cached: false,
  };
  const payload: WeeklyResponse = { weekly, meta };

  // 3) KV yaz (TTL'li). Cache'lenmiş kopyada cached=true işaretle.
  const toCache: WeeklyResponse = { weekly, meta: { ...meta, cached: true } };
  await env.REZERV_CACHE.put(cacheKey, JSON.stringify(toCache), { expirationTtl: ttl });

  return json(payload, 200);
}

/**
 * GET /api/summary — haftalık + günlük nowcast + NIR (C-001).
 * Faz 3 (swap manuel input + dolarizasyon) burada YOK.
 *
 * Akış: haftalık seri çek -> computeWeekly -> çıpa = son haftalık nokta ->
 * günlük seri [çıpa, end] çek -> computeDailyNowcast -> birleştir + meta.
 *
 * Cache: tüm summary tek anahtarda, DAILY_TTL (~1 sa) ile. Summary günlük veri
 * içerdiği için haftalık TTL (~6 sa) değil daha kısa günlük TTL kullanılır;
 * haftalık kısım yalnızca daha taze olur, asla 6 sa sınırından bayatlamaz.
 */
async function handleSummary(url: URL, env: Env): Promise<Response> {
  const start =
    url.searchParams.get("weeklyStart") ??
    url.searchParams.get("start") ??
    env.DEFAULT_WEEKLY_START ??
    FALLBACK_START;
  const end = url.searchParams.get("end") ?? todayDdMmYyyy();

  if (!isValidDdMmYyyy(start) || !isValidDdMmYyyy(end)) {
    return errorResponse("bad_request", "weeklyStart/end `dd-mm-yyyy` olmalı.");
  }

  const ttl = Number(env.DAILY_TTL ?? "") || DEFAULT_DAILY_TTL;
  const cacheKey = `summary:${start}:${end}`;

  // 1) KV oku (cache hit).
  const cached = await env.REZERV_CACHE.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as SummaryResponse;
    parsed.meta.cached = true;
    return json(parsed, 200);
  }

  // 2) Miss: haftalık seri -> computeWeekly.
  const weeklyRows = await fetchSeries(WEEKLY_CODES, start, end, env.TCMB_EVDS_KEY);
  const weekly = computeWeekly(weeklyRows);
  const computed = weeklyMeta(weekly);

  // 3) Çıpa = son haftalık nokta; günlük seri [çıpa, end] aralığında çekilir.
  const anchor = weekly[weekly.length - 1];
  if (!anchor) {
    return errorResponse("empty_series", "Çıpa için haftalık veri yok.");
  }
  const dailyRows = await fetchSeries(
    DAILY_CODES,
    isoToDdMmYyyy(anchor.tarih),
    end,
    env.TCMB_EVDS_KEY,
  );
  const daily = computeDailyNowcast(weekly, dailyRows);
  const latestDaily = daily[daily.length - 1];

  const meta: SummaryMeta = {
    anchorDate: anchor.tarih,
    anchorBrut: anchor.toplam,
    peak: computed.peak,
    latestWeekly: computed.latest.tarih,
    latestDaily: latestDaily ? latestDaily.tarih : anchor.tarih,
    updatedAt: new Date().toISOString(),
    unit: "milyar USD",
    source: "TCMB EVDS",
    cached: false,
  };
  const payload: SummaryResponse = { weekly, daily, meta };

  // 4) KV yaz (TTL'li). Cache'lenmiş kopyada cached=true işaretle.
  const toCache: SummaryResponse = { weekly, daily, meta: { ...meta, cached: true } };
  await env.REZERV_CACHE.put(cacheKey, JSON.stringify(toCache), { expirationTtl: ttl });

  return json(payload, 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return errorResponse("bad_request", "Yalnızca GET destekleniyor.");
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/weekly") {
        return await handleWeekly(url, env);
      }
      if (url.pathname === "/api/summary") {
        return await handleSummary(url, env);
      }
      return errorResponse("not_found", `Bilinmeyen uç: ${url.pathname}`);
    } catch (e) {
      if (e instanceof EvdsError || e instanceof EngineError) {
        return errorResponse(e.code, e.message);
      }
      // Beklenmeyen hata — anahtar/iç detay sızdırma.
      return errorResponse("internal_error", "Beklenmeyen bir hata oluştu.");
    }
  },
} satisfies ExportedHandler<Env>;
