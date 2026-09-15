// M-001b gold-client (Faz 6 / Faz 11) — günlük altın fiyatı (USD/ons) kaynakları.
// Faz 11: TERCİH = TCMB EVDS BİST Kıymetli Madenler USD/ons ağırlıklı ortalama serisi
//   (`GOLD_EVDS_CODE`, varsayılan TP.ALTINPIYASA.AGORT03 — iş günü, İstanbul seansı). Çekim
//   evds-client `fetchSeries` ile yapılır (kural korunur: EVDS'e yalnız evds-client dokunur);
//   burada yalnız SAF satır→harita dönüşümü var (`goldUsdByDateFromRows`).
//   Sebep: Yahoo GC=F NY kapanışıdır (İstanbul seansından ~6 sa sonra; ABD tatillerinde boş) →
//   günlük altın-fiyat etkisinin İŞARETİ bile yanlış çıkabiliyordu (ör. 10→11.09.2026: +1,1 yerine
//   −1,25 mlr); "diğer/döviz akışı" barları bu hatayı ters işaretle yutuyordu.
// FALLBACK (yalnız EVDS altın serisi çekilemez/boşsa): Yahoo Finance v8 chart (GC=F · altın vadeli).
//   >>> İSTİSNA: "evds-client dışında hiçbir modül EVDS'e dokunmaz" kuralı EVDS içindir; Yahoo
//       tek harici bağımlılık olarak burada izole kalır. Soft-fail: çağıran try/catch ile sarmalar
//       → hiçbiri çekilemezse goldPriceEffect null, çekirdek nowcast düşmez. <<<
// Etki ORAN-bazlı olduğundan vadeli↔spot / ağırlıklı-ortalama↔kapanış baz farkı sadeleşir
// (research-gold-price-effect.md).

import type { RawRow } from "./types.ts";

/** EVDS altın fiyatı serisi (varsayılan). Env `GOLD_EVDS_CODE` ile geçersiz kılınabilir. */
export const DEFAULT_GOLD_EVDS_CODE = "TP.ALTINPIYASA.AGORT03";

/**
 * evds-client'ın döndürdüğü ham satırları ISO tarih → USD/ons haritasına çevirir (SAF).
 * `code` noktaları alt çizgiye çevrilerek anahtar bulunur (`TP.X.Y` → `TP_X_Y`). Değer null/0/
 * sonlu-olmayan satırlar atlanır. Boş harita dönebilir (çağıran fallback'e karar verir).
 */
export function goldUsdByDateFromRows(rows: RawRow[], code: string): Map<string, number> {
  const key = code.replace(/\./g, "_");
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(r.tarih.trim());
    const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : r.tarih.trim();
    byDate.set(iso, v);
  }
  return byDate;
}

/** gold-client'ın fırlattığı hata (çağıran soft-fail ile yakalar). */
export class GoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldError";
  }
}

const GC_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F";
const GOLD_TIMEOUT_MS = 15_000;
const DAY_SECONDS = 86_400;

/** ISO `yyyy-mm-dd` → UTC gün başı unix saniye. Eşleşmezse NaN. */
function isoToUnix(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000);
}

/** unix saniye → ISO `yyyy-mm-dd` (UTC). */
function unixToIso(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * [startIso, endIso] aralığı için günlük altın fiyatını (USD/ons) çeker.
 * @returns ISO tarih → fiyat haritası (kapanış; null kapanışlar atlanır).
 * Hata (ağ/parse/boş): `GoldError` fırlatır → çağıran soft-fail.
 */
export async function fetchGoldUsdByDate(
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const p1 = isoToUnix(startIso);
  const p2 = isoToUnix(endIso);
  if (Number.isNaN(p1) || Number.isNaN(p2)) {
    throw new GoldError(`Geçersiz tarih aralığı: ${startIso}..${endIso}`);
  }
  // Çıpa fiyatı için bir miktar geri pay (tatil/haftasonu) + bitişe +1 gün (endeksi kapsa).
  const period1 = p1 - 7 * DAY_SECONDS;
  const period2 = p2 + DAY_SECONDS;
  const url = `${GC_BASE}?period1=${period1}&period2=${period2}&interval=1d`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "tqrlab-reserves/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(GOLD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GoldError(`Altın fiyatına ulaşılamadı: ${(e as Error).message}`);
  }
  if (!res.ok) throw new GoldError(`Altın fiyatı HTTP ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new GoldError(`Altın fiyatı JSON parse edilemedi: ${(e as Error).message}`);
  }

  const result = (body as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }
    | undefined;
  const ts = result?.timestamp;
  const close = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(close) || ts.length === 0) {
    throw new GoldError("Altın fiyatı yanıtı boş/biçimsiz.");
  }

  const byDate = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (typeof c === "number" && Number.isFinite(c)) byDate.set(unixToIso(ts[i]!), c);
  }
  if (byDate.size === 0) throw new GoldError("Altın fiyatı: geçerli kapanış yok.");
  return byDate;
}
