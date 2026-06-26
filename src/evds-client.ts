// M-001 evds-client — EVDS3'ten ham seri çek + normalize et.
// >>> Tek dış temas noktası. evds-client dışında HİÇBİR modül EVDS'e dokunmaz. <<<
// Anahtar HTTP header'ında gider (2024 sonrası kural; URL query'de DEĞİL).
// Kaynak mantık: tcmb_reserves.py `_evds` / `_f`.

import type { ApiErrorCode, RawRow } from "./types.ts";

/** EVDS3 servis kökü. Eski `/service/evds` ÖLÜ — kullanma. */
const EVDS_BASE = "https://evds3.tcmb.gov.tr/igmevdsms-dis/";

/** Üst akış (EVDS) çağrısı için zaman aşımı (ms). Python: timeout=30. */
const EVDS_TIMEOUT_MS = 30_000;

/** evds-client'ın fırlattığı tipli hata. */
export class EvdsError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "EvdsError";
    this.code = code;
  }
}

/** Seri kodundaki noktayı EVDS yanıt anahtarındaki alt çizgiye çevirir. */
function codeToKey(code: string): string {
  return code.replace(/\./g, "_");
}

/** Python `_f`: boş/null/parse edilemez -> null, aksi halde float. */
function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "null") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Yanıt gövdesinden `items` dizisini güvenle çıkarır. */
function extractItems(body: unknown): Record<string, unknown>[] {
  if (typeof body !== "object" || body === null) return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
  );
}

/**
 * EVDS3'ten ham seri çeker ve `RawRow[]`'a normalize eder (contract C-004).
 *
 * @param codes  Seri kodları, ör. `["TP.AB.TOPLAM","TP.AB.C2","TP.AB.C1"]`.
 * @param start  Başlangıç `dd-mm-yyyy`.
 * @param end    Bitiş `dd-mm-yyyy`.
 * @param key    EVDS anahtarı (Worker secret) — header'da gider, asla loglanmaz.
 *
 * Hatalar: `evds_unavailable` (ağ), `evds_auth_failed` (JSON yerine HTML),
 * `non_json_response` (parse), `upstream_timeout` (zaman aşımı).
 */
export async function fetchSeries(
  codes: string[],
  start: string,
  end: string,
  key: string,
): Promise<RawRow[]> {
  const series = codes.join("-");
  const url = `${EVDS_BASE}series=${series}&startDate=${start}&endDate=${end}&type=json`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        key,
        "User-Agent": "tqrlab-reserves/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(EVDS_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new EvdsError("upstream_timeout", "EVDS yanıt vermedi (zaman aşımı).");
    }
    throw new EvdsError("evds_unavailable", `EVDS'e ulaşılamadı: ${err.message}`);
  }

  // JSON dönmezse (content-type html). 5xx -> üst akış geçici olarak erişilemez
  // (ör. TCMB'nin 00:00-02:00 GMT+3 planlı bakımı 503 HTML döner) → evds_unavailable.
  // Diğer durumlarda (2xx/4xx + HTML) anahtar/uç sorunu olası → evds_auth_failed.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("json")) {
    if (res.status >= 500) {
      throw new EvdsError(
        "evds_unavailable",
        `EVDS geçici olarak erişilemiyor (HTTP ${res.status}; olası planlı bakım).`,
      );
    }
    throw new EvdsError(
      "evds_auth_failed",
      `EVDS JSON dönmedi (HTTP ${res.status}). Anahtar/uç kontrol et.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new EvdsError(
      "non_json_response",
      `EVDS yanıtı JSON parse edilemedi: ${(e as Error).message}`,
    );
  }

  const keys = codes.map(codeToKey);
  return extractItems(body).map((it) => {
    const row: RawRow = { tarih: typeof it["Tarih"] === "string" ? it["Tarih"] : "" };
    for (const k of keys) {
      row[k] = parseNum(it[k]);
    }
    return row;
  });
}
