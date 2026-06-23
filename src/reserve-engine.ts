// M-002 reserve-engine — saf, yan etkisiz hesap fonksiyonları.
// Faz 1: `computeWeekly` (+ `weeklyMeta`). Faz 2: + `computeDailyNowcast` (nowcast + NIR).
// Kaynak mantık: tcmb_reserves.py `fetch_weekly` / `fetch_daily_nowcast` normalize adımları.
// >>> Formülleri "iyileştirme"; tcmb_reserves.py'de doğrulandı, birebir port. <<<

import type {
  ApiErrorCode,
  DailyPoint,
  RawRow,
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
  return rows.map((d) => ({
    tarih: d.tarih,
    brutRezerv: anchor.toplam + (d.disVarlikUsd - baseDv),
    nir: d.nir,
  }));
}
