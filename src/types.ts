// M-001..M-004 ortak tipleri. `any` yok; tüm dış değerler buradan geçer.
// Faz 1 kapsamı: yalnızca HAFTALIK brüt rezerv dilimi.

/** Tanımlı API/iç hata kodları (contract C-001 / C-002 / C-004). */
export type ApiErrorCode =
  | "evds_unavailable"
  | "evds_auth_failed"
  | "non_json_response"
  | "empty_series"
  | "upstream_timeout"
  | "bad_request"
  | "not_found"
  | "internal_error";

/** Worker hata yanıtı gövdesi. */
export interface ApiError {
  error: ApiErrorCode;
  message: string;
}

/**
 * EVDS3'ten normalize edilmiş ham satır (C-004).
 * - `tarih`: EVDS ham formatı `dd-mm-yyyy` (ör. "12-06-2026").
 * - Diğer anahtarlar seri kodudur; EVDS yanıtında nokta -> alt çizgi olur
 *   (`TP.AB.TOPLAM` -> `TP_AB_TOPLAM`). Değer boşsa `null`.
 */
export interface RawRow {
  tarih: string;
  [seriesKey: string]: number | null | string;
}

/** Haftalık brüt rezerv noktası — değerler milyar USD (ham milyon / 1000). */
export interface WeeklyPoint {
  /** ISO tarih `yyyy-mm-dd`. */
  tarih: string;
  /** Toplam brüt rezerv (milyar USD). */
  toplam: number;
  /** Döviz, altın hariç (milyar USD). */
  doviz: number;
  /** Altın (milyar USD). */
  altin: number;
}

/** computeWeekly'den türeyen saf meta (peak + latest). */
export interface WeeklyComputedMeta {
  peak: { tarih: string; toplam: number };
  latest: WeeklyPoint;
  count: number;
}

/** /api/weekly yanıt meta'sı (saf meta + worker bağlamı). */
export interface WeeklyMeta extends WeeklyComputedMeta {
  /** Sorguda kullanılan başlangıç (dd-mm-yyyy). */
  start: string;
  /** Sorguda kullanılan bitiş (dd-mm-yyyy). */
  end: string;
  /** Yanıtın üretildiği an (ISO datetime). */
  updatedAt: string;
  unit: "milyar USD";
  source: "TCMB EVDS";
  /** Bu yanıt KV cache'ten mi geldi. */
  cached: boolean;
}

/** GET /api/weekly yanıt gövdesi (C-001 haftalık alt kümesi). */
export interface WeeklyResponse {
  weekly: WeeklyPoint[];
  meta: WeeklyMeta;
}
