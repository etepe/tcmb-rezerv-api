// M-003 api-worker — HTTP route'ları, KV cache, CORS, tanımlı hata yanıtları + cron.
// Faz 1: GET /api/weekly (C-001 haftalık alt kümesi).
// Faz 2: + GET /api/summary (haftalık + günlük nowcast + NIR; C-001).
// Faz 3: + /api/summary.dolarizasyon (haftalık YP mevduat; soft-fail).
// Faz 4: + scheduled() cron — KV ön-ısıtma (M-005, src/scheduled.ts). Fetch+compute
//        mantığı src/summary.ts'e (buildWeekly/buildSummary) ayrıldı; HTTP + cron AYNI yol.

import type { ApiError, ApiErrorCode } from "./types.ts";
import { EvdsError } from "./evds-client.ts";
import { EngineError } from "./reserve-engine.ts";
import {
  buildSummary,
  buildWeekly,
  defaultStart,
  type Env,
  readSummaryCache,
  readSummaryLast,
  readWeeklyCache,
  readWeeklyLast,
  todayDdMmYyyy,
  writeSummaryCache,
  writeWeeklyCache,
} from "./summary.ts";
import { warmCache } from "./scheduled.ts";

// Env tipi summary.ts'te tanımlı; testler ve tüketiciler için buradan re-export edilir.
export type { Env } from "./summary.ts";

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

async function handleWeekly(url: URL, env: Env): Promise<Response> {
  const start = url.searchParams.get("start") ?? defaultStart(env);
  const end = url.searchParams.get("end") ?? todayDdMmYyyy();

  if (!isValidDdMmYyyy(start) || !isValidDdMmYyyy(end)) {
    return errorResponse("bad_request", "start/end `dd-mm-yyyy` olmalı.");
  }

  // 1) KV oku (cache hit).
  const cached = await readWeeklyCache(env, start, end);
  if (cached) return json(cached, 200);

  // 2) Miss: EVDS'ten çek -> hesapla -> KV yaz (TTL'li). EVDS erişilemezse (ör. TCMB
  //    planlı bakımı) 5xx fırlatmak yerine son-bilinen-iyi (last-known-good) veriyi sun.
  try {
    const payload = await buildWeekly(env, start, end);
    await writeWeeklyCache(env, start, end, payload);
    return json(payload, 200);
  } catch (e) {
    const stale = await readWeeklyLast(env, start);
    if (stale) return json(stale, 200);
    throw e;
  }
}

/**
 * GET /api/summary — haftalık + günlük nowcast + NIR + dolarizasyon (C-001).
 *
 * Fetch+compute mantığı `buildSummary` (src/summary.ts) içindedir; cron (M-005) AYNI
 * fonksiyonu kullanarak cache'i ön-ısıtır (kopya yok). Cache: tüm summary tek anahtarda
 * (`summary:{start}:{end}`), DAILY_TTL (~1 sa) ile. UI bu anahtara düşer.
 */
async function handleSummary(url: URL, env: Env): Promise<Response> {
  const start =
    url.searchParams.get("weeklyStart") ??
    url.searchParams.get("start") ??
    defaultStart(env);
  const end = url.searchParams.get("end") ?? todayDdMmYyyy();

  if (!isValidDdMmYyyy(start) || !isValidDdMmYyyy(end)) {
    return errorResponse("bad_request", "weeklyStart/end `dd-mm-yyyy` olmalı.");
  }

  // 1) KV oku (cache hit).
  const cached = await readSummaryCache(env, start, end);
  if (cached) return json(cached, 200);

  // 2) Miss: çek + hesapla (buildSummary) -> KV yaz (TTL'li). EVDS erişilemezse (ör. TCMB
  //    planlı bakımı) 5xx fırlatmak yerine son-bilinen-iyi (last-known-good) veriyi sun.
  try {
    const payload = await buildSummary(env, start, end);
    await writeSummaryCache(env, start, end, payload);
    return json(payload, 200);
  } catch (e) {
    const stale = await readSummaryLast(env, start);
    if (stale) return json(stale, 200);
    throw e;
  }
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

  // Faz 4 — Cron Trigger (wrangler.toml [triggers]). KV ön-ısıtma; public sözleşmeyi
  // değiştirmez. Isıtma işin KENDİSİ olduğundan await edilir (platform tamamlanmayı
  // bekler). Hatalar warmCache içinde yutulur (cron handler ASLA fırlatmaz).
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await warmCache(env);
  },
} satisfies ExportedHandler<Env>;
