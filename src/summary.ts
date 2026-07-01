// M-003/M-005 ortak veri-orkestrasyon katmanı — EVDS çek + hesapla + KV cache.
// HTTP handler (src/index.ts) ve cron (src/scheduled.ts) AYNI yolu paylaşır (kopya yok):
//   buildWeekly/buildSummary  → saf üretim (EVDS çek → reserve-engine ile hesapla; KV'ye DOKUNMAZ).
//   read*/write*Cache         → KV katmanı (TTL + cached damgası).
// Cron yalnız cache'i ön-ısıtır; PUBLIC API SÖZLEŞMESİ DEĞİŞMEZ.
// >>> Formüller burada DEĞİL reserve-engine.ts'te; bu katman yalnız orkestrasyon. <<<

import type {
  DolarPoint,
  ForeignSecPoint,
  SummaryMeta,
  SummaryResponse,
  SwapPoint,
  WeeklyMeta,
  WeeklyResponse,
} from "./types.ts";
import { fetchSeries } from "./evds-client.ts";
import { fetchGoldUsdByDate } from "./gold-client.ts";
import {
  computeDailyNowcast,
  computeDolarizasyon,
  computeForeignSecurities,
  computeGoldPriceEffect,
  computeSwapSplit,
  computeWeekly,
  EngineError,
  weeklyMeta,
} from "./reserve-engine.ts";

/** Worker ortam bağlamı (binding'ler + var'lar). index.ts buradan re-export eder. */
export interface Env {
  /** EVDS anahtarı — `wrangler secret put TCMB_EVDS_KEY`. Asla yanıtta/logda. */
  TCMB_EVDS_KEY: string;
  /** KV cache namespace. */
  REZERV_CACHE: KVNamespace;
  /** Haftalık cache TTL (saniye, string). Varsayılan 21600 (~6 sa). */
  WEEKLY_TTL?: string;
  /** Günlük (summary) cache TTL (saniye, string). Varsayılan 3600 (~1 sa). */
  DAILY_TTL?: string;
  /**
   * Son-bilinen-iyi (last-known-good) fallback TTL (saniye, string). EVDS erişilemezken
   * sunulacak en son başarılı yanıt bu süre KV'de tutulur. Varsayılan 1209600 (~14 gün).
   */
  STALE_TTL?: string;
  /** Varsayılan haftalık başlangıç (dd-mm-yyyy). */
  DEFAULT_WEEKLY_START?: string;
  /** Yabancı MB swap fallback (mlr USD, string). K18 çekilemezse kullanılır. Varsayılan 16.4. */
  YABANCI_MB_FALLBACK?: string;
}

// Seri kodları (evds-client'a verilir; nokta→alt çizgi normalizasyonu engine'de).
const WEEKLY_CODES = ["TP.AB.TOPLAM", "TP.AB.C2", "TP.AB.C1"];
// Günlük: A02/A10/USD nowcast+NIR; A11/A14 swap ayrıştırması (net dış varlık) için (Faz 5).
const DAILY_CODES = ["TP.AB.A02", "TP.AB.A10", "TP.AB.A11", "TP.AB.A14", "TP.DK.USD.A.YTL"];
const DOLARIZASYON_CODES = ["TP.HPBITABLO4.1", "TP.HPBITABLO4.2"];
// Swap (Faz 5): SWAPTEKTAR günlük (yerli banka), DOVVARNC.K18 aylık (yabancı MB).
const SWAP_CODES = ["TP.SWAPTEKTAR.TOTALSTOKALIMYONLU", "TP.SWAPTEKTAR.TOTALSTOKSATIMYONLU"];
const MB_CODES = ["TP.DOVVARNC.K18"];
// Yurt dışı yerleşik menkul kıymet (Faz 7) — HAFTALIK; hisse/DİBS/ÖST × net akım + stok.
//   Kaynak: EVDS datagroup `bie_mknethar` (`TP.MKNETHAR.M*`) — "Yurt Dışı Yerleşiklerin Menkul
//   Kıymet Portföyü"; enstrümanlar "Yurt İçi Piyasa" alt-kalemleri (kullanıcı teyidiyle):
//     Hisse Senedi = M1 (stok) / M7 (net);  DİBS (Kesin Alım) = M2 / M8;  ÖST (GYD sektör) = M6 / M12.
//   reserve-engine.ts'teki K_FS_* anahtarları bunların nokta→alt çizgi karşılığıdır
//   (key === code.replaceAll(".", "_")); İKİSİ BİRLİKTE değişmeli. Birim: milyon USD → /1000.
//   Soft-fail: fetch boş/hatalıysa foreignSecurities=[]; çekirdek dashboard düşmez.
//   (Bağlam serileri — Genel Toplam M13/M20, Yurt Dışı Piyasa/eurobond M15/M22 — ileride eklenebilir.)
const FOREIGN_SEC_CODES = [
  "TP.MKNETHAR.M1", // hisse senedi stok
  "TP.MKNETHAR.M7", // hisse senedi net değişim
  "TP.MKNETHAR.M2", // DİBS (Kesin Alım) stok
  "TP.MKNETHAR.M8", // DİBS (Kesin Alım) net değişim
  "TP.MKNETHAR.M6", // ÖST (GYD sektör) stok
  "TP.MKNETHAR.M12", // ÖST (GYD sektör) net değişim
];

const DEFAULT_WEEKLY_TTL = 21600; // ~6 saat
const DEFAULT_DAILY_TTL = 3600; //   ~1 saat (summary; günlük veri daha sık tazelenir)
const DEFAULT_MB_FALLBACK = 16.4; // Yabancı MB swap fallback (mlr USD) — K18 çekilemezse
const DEFAULT_STALE_TTL = 1_209_600; // ~14 gün (last-known-good fallback)
/** DEFAULT_WEEKLY_START verilmezse kullanılan başlangıç (dd-mm-yyyy). */
export const FALLBACK_START = "01-10-2025";

const UNIT = "milyar USD" as const;
const SOURCE = "TCMB EVDS" as const;

/** Bugünün EVDS `dd-mm-yyyy` formatı (UTC). HTTP handler + cron AYNI anahtarı üretir. */
export function todayDdMmYyyy(): string {
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = now.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/** ISO `yyyy-mm-dd` → EVDS `dd-mm-yyyy`. Eşleşmezse girdiyi aynen döner. */
function isoToDdMmYyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

/** EVDS `dd-mm-yyyy` → ISO `yyyy-mm-dd`. Eşleşmezse girdiyi aynen döner (altın fiyatı aralığı). */
function ddMmYyyyToIso(s: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

/** Varsayılan haftalık başlangıç (env > fallback). HTTP handler + cron paylaşır. */
export function defaultStart(env: Env): string {
  return env.DEFAULT_WEEKLY_START ?? FALLBACK_START;
}

/** KV cache anahtarı — /api/weekly. */
export function weeklyKey(start: string, end: string): string {
  return `weekly:${start}:${end}`;
}
/** KV cache anahtarı — /api/summary (UI'nin düştüğü anahtar). */
export function summaryKey(start: string, end: string): string {
  return `summary:${start}:${end}`;
}

/**
 * Son-bilinen-iyi (last-known-good) anahtarları — yalnız `start`'a bağlı (end=bugün her gün
 * değiştiği için ayrı havuz). Her başarılı build bunu da tazeler; EVDS erişilemezken sunulur.
 */
export function weeklyLastKey(start: string): string {
  return `weekly:last:${start}`;
}
export function summaryLastKey(start: string): string {
  return `summary:last:${start}`;
}

function weeklyTtl(env: Env): number {
  return Number(env.WEEKLY_TTL ?? "") || DEFAULT_WEEKLY_TTL;
}
function summaryTtl(env: Env): number {
  return Number(env.DAILY_TTL ?? "") || DEFAULT_DAILY_TTL;
}
/** Yabancı MB swap fallback değeri (env > sabit). K18 çekilemezse kullanılır. */
function mbFallback(env: Env): number {
  return Number(env.YABANCI_MB_FALLBACK ?? "") || DEFAULT_MB_FALLBACK;
}
function staleTtl(env: Env): number {
  return Number(env.STALE_TTL ?? "") || DEFAULT_STALE_TTL;
}

/**
 * Saf üretim: haftalık seri çek → computeWeekly → WeeklyResponse (cached=false).
 * KV'ye DOKUNMAZ (cache katmanı ayrı). HTTP handler + cron paylaşır.
 */
export async function buildWeekly(
  env: Env,
  start: string,
  end: string,
): Promise<WeeklyResponse> {
  const rows = await fetchSeries(WEEKLY_CODES, start, end, env.TCMB_EVDS_KEY);
  const weekly = computeWeekly(rows);
  const computed = weeklyMeta(weekly);
  const meta: WeeklyMeta = {
    ...computed,
    start,
    end,
    updatedAt: new Date().toISOString(),
    unit: UNIT,
    source: SOURCE,
    cached: false,
  };
  return { weekly, meta };
}

/**
 * Saf üretim: haftalık + günlük nowcast + NIR + dolarizasyon → SummaryResponse
 * (cached=false). KV'ye DOKUNMAZ. handleSummary'nin eski cache-miss gövdesiyle birebir.
 *
 * Dolarizasyon (Faz 3) / swap (Faz 5) / altın-fiyat (Faz 6) / yurtdışı menkul kıymet (Faz 7)
 * soft-fail: EVDS'ten çekilemez/boşsa `[]`/null döner; çekirdek haftalık/günlük dashboard
 * ikincil panellere bağımlı olmaz.
 *
 * Hatalar: EvdsError / EngineError (index.ts catch'i tanımlı hata koduna çevirir).
 */
export async function buildSummary(
  env: Env,
  start: string,
  end: string,
): Promise<SummaryResponse> {
  // 1) Haftalık seri → computeWeekly.
  const weeklyRows = await fetchSeries(WEEKLY_CODES, start, end, env.TCMB_EVDS_KEY);
  const weekly = computeWeekly(weeklyRows);
  const computed = weeklyMeta(weekly);

  // 2) Çıpa = son haftalık nokta; günlük seri [çıpa, end] aralığında çekilir.
  //    computeWeekly boş seride zaten fırlatır → anchor pratikte hep dolu (savunmacı kontrol).
  const anchor = weekly[weekly.length - 1];
  if (!anchor) {
    throw new EngineError("empty_series", "Çıpa için haftalık veri yok.");
  }
  const dailyRows = await fetchSeries(
    DAILY_CODES,
    isoToDdMmYyyy(anchor.tarih),
    end,
    env.TCMB_EVDS_KEY,
  );
  let daily = computeDailyNowcast(weekly, dailyRows);
  const latestDaily = daily[daily.length - 1];

  // 2b) Altın-fiyat etkisi (Faz 6) — best-effort/soft-fail. HARİCİ (EVDS-dışı) günlük altın
  //     fiyatı [çıpa, end] aralığında çekilir; computeGoldPriceEffect daily[].goldPriceEffect'i
  //     doldurur. Çekilemezse goldPriceEffect null kalır + goldPriceSource "unavailable"
  //     (çekirdek nowcast/NIR düşmez).
  let goldPriceSource: SummaryMeta["goldPriceSource"] = "unavailable";
  try {
    const goldUsdByDate = await fetchGoldUsdByDate(anchor.tarih, ddMmYyyyToIso(end));
    daily = computeGoldPriceEffect(weekly, daily, goldUsdByDate);
    // Hiç noktaya etki yazılamadıysa (oran kurulamadı) kaynağı "unavailable" tut.
    if (daily.some((d) => d.goldPriceEffect !== null)) goldPriceSource = "external:yahoo-gcf";
  } catch {
    goldPriceSource = "unavailable";
  }

  // 3) Haftalık dolarizasyon (YP mevduat) — best-effort/soft-fail.
  let dolarizasyon: DolarPoint[] = [];
  try {
    const dolarRows = await fetchSeries(DOLARIZASYON_CODES, start, end, env.TCMB_EVDS_KEY);
    dolarizasyon = computeDolarizasyon(dolarRows);
  } catch {
    dolarizasyon = [];
  }

  // 4) Swap ayrıştırması (Faz 5) — best-effort/soft-fail. Yerli banka SWAPTEKTAR'dan (günlük,
  //    [çıpa,end]), Yabancı MB DOVVARNC.K18'den (aylık adım, [start,end]); fallback sabiti env'den.
  //    dailyRows (A02/A11/A14/USD) yeniden kullanılır — ek A02 çekilmez.
  let swap: SwapPoint[] = [];
  let swapMbSource: SummaryMeta["swapMbSource"] = "fallback";
  let swapMb = mbFallback(env);
  try {
    const [swapRows, mbRows] = await Promise.all([
      fetchSeries(SWAP_CODES, isoToDdMmYyyy(anchor.tarih), end, env.TCMB_EVDS_KEY),
      fetchSeries(MB_CODES, start, end, env.TCMB_EVDS_KEY),
    ]);
    const split = computeSwapSplit(dailyRows, swapRows, mbRows, mbFallback(env));
    swap = split.points;
    swapMbSource = split.mbSource;
    swapMb = split.mb;
  } catch {
    swap = [];
    swapMbSource = "fallback";
    swapMb = mbFallback(env);
  }

  // 5) Yurt dışı yerleşik menkul kıymet (Faz 7) — best-effort/soft-fail. HAFTALIK ([start,end]);
  //    hisse/DİBS/ÖST net akım + stok. EVDS'ten çekilemez/boşsa `[]` → yeni sekme "veri yok",
  //    çekirdek rezerv dashboard'u etkilenmez (dolarizasyon/swap ile aynı desen).
  let foreignSecurities: ForeignSecPoint[] = [];
  try {
    const fsRows = await fetchSeries(FOREIGN_SEC_CODES, start, end, env.TCMB_EVDS_KEY);
    foreignSecurities = computeForeignSecurities(fsRows);
  } catch {
    foreignSecurities = [];
  }

  const meta: SummaryMeta = {
    anchorDate: anchor.tarih,
    anchorBrut: anchor.toplam,
    peak: computed.peak,
    latestWeekly: computed.latest.tarih,
    latestDaily: latestDaily ? latestDaily.tarih : anchor.tarih,
    updatedAt: new Date().toISOString(),
    unit: UNIT,
    source: SOURCE,
    swapMbSource,
    swapMb,
    goldPriceSource,
    cached: false,
  };
  return { weekly, daily, dolarizasyon, swap, foreignSecurities, meta };
}

/** KV'den weekly oku; varsa cached=true işaretle, yoksa null. */
export async function readWeeklyCache(
  env: Env,
  start: string,
  end: string,
): Promise<WeeklyResponse | null> {
  const hit = await env.REZERV_CACHE.get(weeklyKey(start, end));
  if (!hit) return null;
  const parsed = JSON.parse(hit) as WeeklyResponse;
  parsed.meta.cached = true;
  return parsed;
}

/**
 * weekly'yi KV'ye yaz (TTL'li, cached=true damgalı). HTTP miss yolu + cron kullanır.
 * Ayrıca uzun-TTL'li son-bilinen-iyi (last-known-good) havuzunu tazeler → EVDS düşse de
 * dashboard `readWeeklyLast` ile ayakta kalır.
 */
export async function writeWeeklyCache(
  env: Env,
  start: string,
  end: string,
  payload: WeeklyResponse,
): Promise<void> {
  const toCache: WeeklyResponse = { ...payload, meta: { ...payload.meta, cached: true } };
  const serialized = JSON.stringify(toCache);
  await Promise.all([
    env.REZERV_CACHE.put(weeklyKey(start, end), serialized, {
      expirationTtl: weeklyTtl(env),
    }),
    env.REZERV_CACHE.put(weeklyLastKey(start), serialized, {
      expirationTtl: staleTtl(env),
    }),
  ]);
}

/**
 * Son-bilinen-iyi weekly'yi oku (EVDS erişilemezken fallback). cached=true + stale=true
 * damgalı; `updatedAt` orijinal (eski) üretim anını korur. Yoksa null.
 */
export async function readWeeklyLast(
  env: Env,
  start: string,
): Promise<WeeklyResponse | null> {
  const hit = await env.REZERV_CACHE.get(weeklyLastKey(start));
  if (!hit) return null;
  const parsed = JSON.parse(hit) as WeeklyResponse;
  parsed.meta.cached = true;
  parsed.meta.stale = true;
  return parsed;
}

/** KV'den summary oku; varsa cached=true işaretle, yoksa null. */
export async function readSummaryCache(
  env: Env,
  start: string,
  end: string,
): Promise<SummaryResponse | null> {
  const hit = await env.REZERV_CACHE.get(summaryKey(start, end));
  if (!hit) return null;
  const parsed = JSON.parse(hit) as SummaryResponse;
  parsed.meta.cached = true;
  return parsed;
}

/**
 * summary'yi KV'ye yaz (TTL'li, cached=true damgalı). HTTP miss yolu + cron kullanır.
 * Ayrıca uzun-TTL'li son-bilinen-iyi (last-known-good) havuzunu tazeler → EVDS düşse de
 * dashboard `readSummaryLast` ile ayakta kalır.
 */
export async function writeSummaryCache(
  env: Env,
  start: string,
  end: string,
  payload: SummaryResponse,
): Promise<void> {
  const toCache: SummaryResponse = { ...payload, meta: { ...payload.meta, cached: true } };
  const serialized = JSON.stringify(toCache);
  await Promise.all([
    env.REZERV_CACHE.put(summaryKey(start, end), serialized, {
      expirationTtl: summaryTtl(env),
    }),
    env.REZERV_CACHE.put(summaryLastKey(start), serialized, {
      expirationTtl: staleTtl(env),
    }),
  ]);
}

/**
 * Son-bilinen-iyi summary'yi oku (EVDS erişilemezken fallback). cached=true + stale=true
 * damgalı; `updatedAt` orijinal (eski) üretim anını korur. Yoksa null.
 */
export async function readSummaryLast(
  env: Env,
  start: string,
): Promise<SummaryResponse | null> {
  const hit = await env.REZERV_CACHE.get(summaryLastKey(start));
  if (!hit) return null;
  const parsed = JSON.parse(hit) as SummaryResponse;
  parsed.meta.cached = true;
  parsed.meta.stale = true;
  return parsed;
}
