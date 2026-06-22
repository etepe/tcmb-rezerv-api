// M-002 reserve-engine — saf, yan etkisiz hesap fonksiyonları.
// Faz 1: yalnızca `computeWeekly` (+ `weeklyMeta`).
// Kaynak mantık: tcmb_reserves.py `fetch_weekly` normalize adımı.
// >>> Formülleri "iyileştirme"; tcmb_reserves.py'de doğrulandı, birebir port. <<<

import type { ApiErrorCode, RawRow, WeeklyComputedMeta, WeeklyPoint } from "./types.ts";

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
