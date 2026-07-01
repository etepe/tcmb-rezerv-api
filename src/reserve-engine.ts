// M-002 reserve-engine — saf, yan etkisiz hesap fonksiyonları.
// Faz 1: `computeWeekly` (+ `weeklyMeta`). Faz 2: + `computeDailyNowcast` (nowcast + NIR).
// Faz 3: + `computeDolarizasyon` (haftalık YP mevduat → DolarPoint[]).
// Kaynak mantık: tcmb_reserves.py `fetch_weekly` / `fetch_daily_nowcast` normalize adımları.
// >>> Formülleri "iyileştirme"; tcmb_reserves.py'de doğrulandı, birebir port. <<<

import type {
  ApiErrorCode,
  DailyPoint,
  DolarPoint,
  ForeignSecPoint,
  RawRow,
  SwapPoint,
  WeeklyComputedMeta,
  WeeklyPoint,
} from "./types.ts";

/** reserve-engine'in fırlattığı tipli hata. */
export class EngineError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

// EVDS yanıt anahtarları (nokta -> alt çizgi).
const K_TOPLAM = "TP_AB_TOPLAM"; // TP.AB.TOPLAM  — toplam brüt rezerv
const K_DOVIZ = "TP_AB_C2"; //      TP.AB.C2      — döviz (altın hariç)
const K_ALTIN = "TP_AB_C1"; //      TP.AB.C1      — altın
// Günlük analitik bilanço (İŞ GÜNÜ).
const K_A02 = "TP_AB_A02"; //       TP.AB.A02        — Dış Varlıklar (bin TL)
const K_A10 = "TP_AB_A10"; //       TP.AB.A10        — Toplam Döviz Yükümlülükleri (bin TL)
const K_USD = "TP_DK_USD_A_YTL"; // TP.DK.USD.A.YTL  — USD alış kuru (TL)
// Haftalık YP mevduat (dolarizasyon) — milyon USD.
const K_YP_TOPLAM = "TP_HPBITABLO4_1"; //  TP.HPBITABLO4.1 — toplam YP mevduat
const K_YP_YURTICI = "TP_HPBITABLO4_2"; // TP.HPBITABLO4.2 — yurt içi yerleşik YP mevduat
// Swap ayrıştırması (Faz 5).
const K_A11 = "TP_AB_A11"; //  TP.AB.A11 — yurt dışı yerleşiklere yükümlülük (bin TL)
const K_A14 = "TP_AB_A14"; //  TP.AB.A14 — bankacılık sektörü YP mevduatı (bin TL)
const K_SWAP_ALIM = "TP_SWAPTEKTAR_TOTALSTOKALIMYONLU"; //  toplam swap stok, alım yönlü (milyon USD)
const K_SWAP_SATIM = "TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU"; // toplam swap stok, satım yönlü (milyon USD)
const K_MB_K18 = "TP_DOVVARNC_K18"; // SDDS 2.2.1.3 (4ay–1yıl swap bacağı) = yabancı-MB swap (milyon USD)
// ── Yurt dışı yerleşik menkul kıymet istatistikleri (Faz 7) — yanıt anahtarları (nokta→alt çizgi).
//    Bu anahtarlar summary.ts'teki FOREIGN_SEC_CODES seri kodlarının nokta→alt çizgi karşılığıdır
//    (key === code.replaceAll(".", "_")); ikisi BİRLİKTE güncellenmeli.
//    ⚠️ DOĞRULANACAK: aşağıdaki 6 leaf kod EVDS "Menkul Kıymet İstatistikleri" (datagroup bie_kt100h /
//       dashboard 1406) UI'sından teyit edilip GÜNCELLE. Yanlış/eksikse fetch boş döner → soft-fail
//       ile foreignSecurities=[] (çekirdek dashboard etkilenmez). Bkz. summary.ts FOREIGN_SEC_CODES.
const K_FS_HISSE_FLOW = "TP_MK_YDY_HISSE_NET"; //   yurt dışı yerleşik hisse senedi net alım (milyon USD)
const K_FS_HISSE_STOCK = "TP_MK_YDY_HISSE_STOK"; // hisse senedi stok, piyasa değeriyle (milyon USD)
const K_FS_DIBS_FLOW = "TP_MK_YDY_DIBS_NET"; //     DİBS net alım (milyon USD)
const K_FS_DIBS_STOCK = "TP_MK_YDY_DIBS_STOK"; //   DİBS stok (milyon USD)
const K_FS_OST_FLOW = "TP_MK_YDY_OST_NET"; //       ÖST net alım (milyon USD)
const K_FS_OST_STOCK = "TP_MK_YDY_OST_STOK"; //     ÖST stok (milyon USD)

/** RawRow'dan sayısal değer (yalnız number; string/null/undefined -> null). */
function num(row: RawRow, key: string): number | null {
  const v = row[key];
  return typeof v === "number" ? v : null;
}

/** EVDS `dd-mm-yyyy` -> ISO `yyyy-mm-dd`. Eşleşmezse girdiyi aynen döner. */
function isoDate(ddmmyyyy: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(ddmmyyyy.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ddmmyyyy;
}

/**
 * Ham TP.AB.TOPLAM/C2/C1 satırlarından `WeeklyPoint[]` türetir (contract C-002).
 * - `toplam` null olan satırlar atılır (Python: `dropna(subset=["toplam"])`).
 * - Değerler /1000 (milyon USD -> milyar USD).
 * - Tarih ISO'ya çevrilir ve artan sıralanır.
 *
 * Hata: `empty_series` (geçerli satır yok).
 */
export function computeWeekly(rows: RawRow[]): WeeklyPoint[] {
  const points: WeeklyPoint[] = [];
  for (const row of rows) {
    const toplam = num(row, K_TOPLAM);
    if (toplam === null) continue; // dropna(subset=["toplam"])
    const doviz = num(row, K_DOVIZ);
    const altin = num(row, K_ALTIN);
    points.push({
      tarih: isoDate(row.tarih),
      toplam: toplam / 1000,
      // Üç haftalık seri birlikte yayımlanır; doviz/altin pratikte hep dolu.
      doviz: doviz === null ? 0 : doviz / 1000,
      altin: altin === null ? 0 : altin / 1000,
    });
  }
  if (points.length === 0) {
    throw new EngineError("empty_series", "Haftalık seri boş (geçerli 'toplam' yok).");
  }
  points.sort((a, b) => a.tarih.localeCompare(b.tarih));
  return points;
}

/**
 * `WeeklyPoint[]` -> peak (en yüksek toplam) + latest (son tarih) meta'sı.
 * Hata: `empty_series`.
 */
export function weeklyMeta(weekly: WeeklyPoint[]): WeeklyComputedMeta {
  const first = weekly[0];
  if (!first) {
    throw new EngineError("empty_series", "Meta için haftalık veri yok.");
  }
  let peak = first;
  for (const p of weekly) {
    if (p.toplam > peak.toplam) peak = p;
  }
  const latest = weekly[weekly.length - 1] ?? first;
  return {
    peak: { tarih: peak.tarih, toplam: peak.toplam },
    latest,
    count: weekly.length,
  };
}

/** Günlük satırdan türeyen ara değer (sıralama + çıpa eşleştirmesi için). */
interface DailyInner {
  tarih: string;
  disVarlikUsd: number;
  nir: number | null;
}

/**
 * Günlük brüt rezerv nowcast + NIR türetir (contract C-003).
 * Kaynak: tcmb_reserves.py `fetch_daily_nowcast` (hesap adımı; ağ kısmı Worker'da).
 *
 * Formüller (CLAUDE.md — doğrulanmış, birebir port):
 *   disVarlikUsd(t) = A02(t) / USD(t) / 1e6           (A02 bin TL -> milyar USD)
 *   NIR(t)          = (A02(t) - A10(t)) / USD(t) / 1e6
 *   brutRezerv(t)   = toplam(çıpa) + ( disVarlikUsd(t) - disVarlikUsd(çıpa) )
 *
 * Çıpa = `weekly`'nin SON noktası (aralıktaki son resmi haftalık Cuma). Çıpa günü
 * günlük seride de bulunmalı (Cuma iş günüdür → vardır).
 *
 * - Python `if a02 and usd`: A02/USD yoksa (veya 0) o gün atlanır.
 * - A10 yoksa **veya 0** ise NIR `null` (Python `if a10` 0'da da falsy); nokta yine de
 *   tutulur (brutRezerv geçerli). A10 pratikte hiç 0 olmaz; fidelite için birebir.
 *
 * Hatalar: `no_anchor` (haftalık boş), `anchor_not_in_daily` (çıpa günü günlükte yok).
 */
export function computeDailyNowcast(
  weekly: WeeklyPoint[],
  dailyRows: RawRow[],
): DailyPoint[] {
  // 1) Çıpa: son resmi haftalık nokta (computeWeekly artan sıralı döner).
  const anchor = weekly[weekly.length - 1];
  if (!anchor) {
    throw new EngineError("no_anchor", "Nowcast çıpası yok: haftalık seri boş.");
  }

  // 2) Günlük satırları normalize et (Python: if a02 and usd).
  const rows: DailyInner[] = [];
  for (const r of dailyRows) {
    const a02 = num(r, K_A02);
    const a10 = num(r, K_A10);
    const usd = num(r, K_USD);
    if (a02 === null || a02 === 0 || usd === null || usd === 0) continue;
    rows.push({
      tarih: isoDate(r.tarih),
      disVarlikUsd: a02 / usd / 1e6,
      // Python `(a02 - a10)/usd/1e6 if a10 else None` — a10 null VEYA 0 ise null.
      nir: a10 === null || a10 === 0 ? null : (a02 - a10) / usd / 1e6,
    });
  }
  rows.sort((a, b) => a.tarih.localeCompare(b.tarih));

  // 3) Çıpa günü günlük seride olmalı.
  const base = rows.find((d) => d.tarih === anchor.tarih);
  if (!base) {
    throw new EngineError(
      "anchor_not_in_daily",
      `Çıpa Cuma (${anchor.tarih}) günlük seride bulunamadı.`,
    );
  }
  const baseDv = base.disVarlikUsd;

  // 4) Nowcast: brut(t) = toplam(çıpa) + (disVarlik(t) − disVarlik(çıpa)).
  //    goldPriceEffect başlangıçta null; harici altın fiyatı varsa computeGoldPriceEffect doldurur.
  return rows.map((d) => ({
    tarih: d.tarih,
    brutRezerv: anchor.toplam + (d.disVarlikUsd - baseDv),
    nir: d.nir,
    goldPriceEffect: null,
  }));
}

/** ISO tarih anahtarlı altın fiyatı haritasında, `iso`'ya eşit/önceki en yakın fiyat (USD/ons). */
function priceOnOrBefore(sortedDates: string[], byDate: Map<string, number>, iso: string): number | null {
  let chosen: number | null = null;
  for (const d of sortedDates) {
    if (d <= iso) chosen = byDate.get(d) ?? chosen;
    else break;
  }
  return chosen;
}

/**
 * Günlük KÜMÜLATİF altın-fiyat değerleme etkisini hesaplar (Faz 6 — saf, yan etkisiz).
 * Doğrulanmış yöntem (research-gold-price-effect.md): altın miktarı çıpadan (son resmi Cuma)
 * itibaren kısa pencerede SABİT kabul edilir → fiyat hareketi haftalık C1 (altın USD değeri)
 * üzerinden etkiye çevrilir. Oran-bazlı olduğundan altın fiyatı serisinin mutlak seviyesi/baz
 * farkı sadeleşir (futures ≈ spot kullanılabilir):
 *
 *   anchorAltin = weekly[son].altin (milyar USD, C1)
 *   etki_kum(t) = anchorAltin × ( altınFiyatı(t) / altınFiyatı(çıpa) − 1 )
 *
 * - `goldUsdByDate`: ISO tarih → altın fiyatı (USD/ons), harici kaynaktan (EVDS-dışı).
 * - Çıpa fiyatı ya da o güne ait fiyat yoksa (en yakın önceki de yoksa) o nokta `null` kalır.
 * - Çıpa altını yoksa/0 ise tüm etkiler `null` (anlamlı oran kurulamaz).
 * - Saf: yeni dizi döner; girdeki diğer alanlar korunur. Soft-fail dostu (boş harita → hepsi null).
 */
export function computeGoldPriceEffect(
  weekly: WeeklyPoint[],
  daily: DailyPoint[],
  goldUsdByDate: Map<string, number>,
): DailyPoint[] {
  const anchor = weekly[weekly.length - 1];
  const sorted = [...goldUsdByDate.keys()].sort();
  const anchorAltin = anchor?.altin ?? 0;
  const anchorPrice = anchor ? priceOnOrBefore(sorted, goldUsdByDate, anchor.tarih) : null;

  // Anlamlı oran kurulamıyorsa (çıpa fiyatı/altını yok) tümünü null bırak.
  if (!anchor || anchorAltin <= 0 || anchorPrice === null || anchorPrice === 0) {
    return daily.map((d) => ({ ...d, goldPriceEffect: null }));
  }

  return daily.map((d) => {
    const p = priceOnOrBefore(sorted, goldUsdByDate, d.tarih);
    const goldPriceEffect = p === null ? null : anchorAltin * (p / anchorPrice - 1);
    return { ...d, goldPriceEffect };
  });
}

/**
 * Ham TP.HPBITABLO4.1/.2 satırlarından `DolarPoint[]` türetir (Faz 3 — dolarizasyon).
 * - `ypToplam` null olan satırlar atılır (computeWeekly `dropna` deseni).
 * - Değerler /1000 (milyon USD -> milyar USD).
 * - Tarih ISO'ya çevrilir ve artan sıralanır.
 *
 * HAFTALIK YP mevduat (analist günlük DTH'inden farklı; ham veri, ayrıştırma YOK).
 * Hata: `empty_series` (geçerli satır yok) — handleSummary'de soft-fail ile yakalanır.
 */
export function computeDolarizasyon(rows: RawRow[]): DolarPoint[] {
  const points: DolarPoint[] = [];
  for (const row of rows) {
    const ypToplam = num(row, K_YP_TOPLAM);
    if (ypToplam === null) continue; // toplam yoksa atla
    const ypYurtici = num(row, K_YP_YURTICI);
    points.push({
      tarih: isoDate(row.tarih),
      ypToplam: ypToplam / 1000,
      // İki haftalık seri birlikte yayımlanır; yurt içi pratikte hep dolu.
      ypYurtici: ypYurtici === null ? 0 : ypYurtici / 1000,
    });
  }
  if (points.length === 0) {
    throw new EngineError("empty_series", "Dolarizasyon serisi boş (geçerli YP mevduat yok).");
  }
  points.sort((a, b) => a.tarih.localeCompare(b.tarih));
  return points;
}

/**
 * Tarih dizgesinden karşılaştırılabilir ay anahtarı `yyyy-mm` üretir.
 * EVDS aylık seri `yyyy-m`/`yyyy-mm`, günlük `dd-mm-yyyy`, ISO `yyyy-mm-dd` formatlarını kabul eder.
 */
function monthKey(tarih: string): string {
  const t = tarih.trim();
  const ym = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(t); // yyyy-m / yyyy-mm / yyyy-mm-dd
  if (ym) return `${ym[1]}-${ym[2]!.padStart(2, "0")}`;
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t); // dd-mm-yyyy
  if (dmy) return `${dmy[3]}-${dmy[2]}`;
  return t;
}

/** computeSwapSplit sonucu — noktalar + Yabancı MB kaynağı/değeri (meta için). */
export interface SwapSplit {
  points: SwapPoint[];
  /** Yabancı MB K18 aylık serisinden mi (`evds:K18`) yoksa fallback sabitinden mi geldi. */
  mbSource: "evds:K18" | "fallback";
  /** En güncel noktada kullanılan Yabancı MB değeri (milyar USD). */
  mb: number;
}

/**
 * Günlük swap ayrıştırması + swap hariç net dış varlık (Faz 5 — saf, yan etkisiz).
 * Kaynak: research-swap-split-method.md (42 analist tablosu + canlı EVDS ile doğrulandı).
 *
 *   netDahil(t)   = (A02 − A11 − A14) / USD / 1e6                  (≡ NIR + A13)
 *   yerliBanka(t) = (SWAP_ALIM − SWAP_SATIM) / 1000               (günlük, +alım/−satım)
 *   yabanciMb     = |K18| / 1000  (aylık adım: o ayın değeri, yoksa en yakın önceki ay;
 *                                  hiç K18 yoksa `fallbackMb`)
 *   toplamSwap    = yabanciMb + yerliBanka ;  netHaric = netDahil − toplamSwap
 *
 * - `dailyRows`: computeDailyNowcast ile AYNI günlük satırlar (A02/A11/A14/USD içerir).
 * - A02/USD olmayan günler atlanır (nowcast deseni). Belirli güne ait SWAPTEKTAR satırı
 *   yoksa (alım ve satım birlikte null) o gün ATLANIR — değer uydurulmaz.
 * - Soft-fail dostu: hiç nokta yoksa boş sonuç döner (fırlatmaz); buildSummary'de try/catch sarmalı.
 */
export function computeSwapSplit(
  dailyRows: RawRow[],
  swapRows: RawRow[],
  mbRows: RawRow[],
  fallbackMb: number,
): SwapSplit {
  // 1) Yabancı MB aylık adım serisi: |K18|/1000, ay anahtarına göre artan sıralı.
  const mbByMonth: { month: string; mb: number }[] = [];
  for (const r of mbRows) {
    const v = num(r, K_MB_K18);
    if (v === null) continue;
    mbByMonth.push({ month: monthKey(r.tarih), mb: Math.abs(v) / 1000 });
  }
  mbByMonth.sort((a, b) => a.month.localeCompare(b.month));
  const hasMb = mbByMonth.length > 0;

  // Bir güne ait Yabancı MB: o ayın K18'i; yoksa en yakın önceki ay; o da yoksa en erken; hiç yoksa fallback.
  const mbFor = (iso: string): number => {
    if (!hasMb) return fallbackMb;
    const mk = monthKey(iso);
    let chosen = mbByMonth[0]!.mb; // mk tüm verilerden önceyse en erken ayı kullan
    for (const e of mbByMonth) {
      if (e.month <= mk) chosen = e.mb;
      else break;
    }
    return chosen;
  };

  // 2) SWAPTEKTAR günlük: ISO tarih -> (alım, satım) stok.
  const swapByDate = new Map<string, { alim: number | null; satim: number | null }>();
  for (const r of swapRows) {
    swapByDate.set(isoDate(r.tarih), {
      alim: num(r, K_SWAP_ALIM),
      satim: num(r, K_SWAP_SATIM),
    });
  }

  // 3) Günlük satırları dolaş; A02/USD ve swap verisi olan günler için SwapPoint üret.
  const points: SwapPoint[] = [];
  for (const r of dailyRows) {
    const a02 = num(r, K_A02);
    const usd = num(r, K_USD);
    if (a02 === null || a02 === 0 || usd === null || usd === 0) continue;
    const iso = isoDate(r.tarih);
    const sw = swapByDate.get(iso);
    if (!sw || (sw.alim === null && sw.satim === null)) continue; // swap verisi yok -> uydurma
    const a11 = num(r, K_A11);
    const a14 = num(r, K_A14);
    const netDahil = (a02 - (a11 ?? 0) - (a14 ?? 0)) / usd / 1e6;
    const yerliBanka = ((sw.alim ?? 0) - (sw.satim ?? 0)) / 1000;
    const yabanciMb = mbFor(iso);
    const toplamSwap = yabanciMb + yerliBanka;
    points.push({
      tarih: iso,
      netDahil,
      yabanciMb,
      yerliBanka,
      toplamSwap,
      netHaric: netDahil - toplamSwap,
    });
  }
  points.sort((a, b) => a.tarih.localeCompare(b.tarih));

  const last = points[points.length - 1];
  return {
    points,
    mbSource: hasMb ? "evds:K18" : "fallback",
    mb: last ? last.yabanciMb : fallbackMb,
  };
}

/**
 * Ham yurt dışı yerleşik menkul kıymet satırlarından `ForeignSecPoint[]` türetir (Faz 7).
 * `computeDolarizasyon` desenini izler: `num` → /1000 (milyon USD → milyar USD) → `isoDate` → sırala.
 *
 * Her enstrüman için akım (net alım) + stok. Kısmi haftalara toleranslı: bir alan yoksa 0 kabul edilir
 * (akım günlük/erken yayımda eksik olabilir; stok Cuma yayımlanır). Altı alan da null olan satır ATLANIR.
 *
 * HAFTALIK ham veri, ayrıştırma/uydurma YOK. Hata: `empty_series` (hiç geçerli satır yok) —
 * buildSummary'de try/catch ile soft-fail'e (foreignSecurities=[]) dönüşür.
 */
export function computeForeignSecurities(rows: RawRow[]): ForeignSecPoint[] {
  const points: ForeignSecPoint[] = [];
  for (const row of rows) {
    const hf = num(row, K_FS_HISSE_FLOW);
    const hs = num(row, K_FS_HISSE_STOCK);
    const df = num(row, K_FS_DIBS_FLOW);
    const ds = num(row, K_FS_DIBS_STOCK);
    const of = num(row, K_FS_OST_FLOW);
    const os = num(row, K_FS_OST_STOCK);
    // Altı ölçü de yoksa gerçek veri yok → satırı atla (uydurma 0 noktası üretme).
    if (hf === null && hs === null && df === null && ds === null && of === null && os === null) {
      continue;
    }
    points.push({
      tarih: isoDate(row.tarih),
      hisseFlow: (hf ?? 0) / 1000,
      hisseStock: (hs ?? 0) / 1000,
      dibsFlow: (df ?? 0) / 1000,
      dibsStock: (ds ?? 0) / 1000,
      ostFlow: (of ?? 0) / 1000,
      ostStock: (os ?? 0) / 1000,
    });
  }
  if (points.length === 0) {
    throw new EngineError("empty_series", "Yurtdışı menkul kıymet serisi boş (geçerli satır yok).");
  }
  points.sort((a, b) => a.tarih.localeCompare(b.tarih));
  return points;
}
