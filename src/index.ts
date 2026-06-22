// M-003 api-worker — HTTP route'ları, KV cache, CORS, tanımlı hata yanıtları.
// Faz 1: yalnızca GET /api/weekly (C-001 haftalık alt kümesi).

import type { ApiError, ApiErrorCode, WeeklyMeta, WeeklyResponse } from "./types.ts";
import { EvdsError, fetchSeries } from "./evds-client.ts";
import { computeWeekly, EngineError, weeklyMeta } from "./reserve-engine.ts";

export interface Env {
  /** EVDS anahtarı — `wrangler secret put TCMB_EVDS_KEY`. Asla yanıtta/logda. */
  TCMB_EVDS_KEY: string;
  /** KV cache namespace. */
  REZERV_CACHE: KVNamespace;
  /** Haftalık cache TTL (saniye, string). Varsayılan 21600 (~6 sa). */
  WEEKLY_TTL?: string;
  /** Varsayılan haftalık başlangıç (dd-mm-yyyy). */
  DEFAULT_WEEKLY_START?: string;
}

// Haftalık brüt rezerv seri kodları.
const WEEKLY_CODES = ["TP.AB.TOPLAM", "TP.AB.C2", "TP.AB.C1"];
const DEFAULT_WEEKLY_TTL = 21600; // ~6 saat
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
