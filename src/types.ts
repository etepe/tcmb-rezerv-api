// M-001..M-004 ortak tipleri. `any` yok; tüm dış değerler buradan geçer.
// Faz 1: HAFTALIK brüt rezerv. Faz 2: + GÜNLÜK nowcast + NIR (`/api/summary`).
// Faz 3: + HAFTALIK dolarizasyon (YP mevduat) `/api/summary.dolarizasyon`.
// (Swap manuel input UI tarafında — API'de swap hesabı YOK.)

/** Tanımlı API/iç hata kodları (contract C-001 / C-002 / C-003 / C-004). */
export type ApiErrorCode =
  | "evds_unavailable"
  | "evds_auth_failed"
  | "non_json_response"
  | "empty_series"
  | "upstream_timeout"
  // C-003 — computeDailyNowcast (Faz 2)
  | "no_anchor"
  | "anchor_not_in_daily"
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
  /**
   * Üst akış (EVDS) erişilemediğinde son-bilinen-iyi (last-known-good) veri sunuldu.
   * `updatedAt` bu verinin üretildiği (eski) anı gösterir; UI "X tarihli veri" diyebilir.
   */
  stale?: boolean;
}

/** GET /api/weekly yanıt gövdesi (C-001 haftalık alt kümesi). */
export interface WeeklyResponse {
  weekly: WeeklyPoint[];
  meta: WeeklyMeta;
}

/**
 * Günlük brüt rezerv nowcast noktası — değerler milyar USD (C-003).
 * `brutRezerv`: çıpa (son resmi haftalık) + günlük Dış Varlık (A02) değişimi.
 * `nir`: net uluslararası rezerv; A10 (döviz yükümlülükleri) yoksa `null`.
 */
export interface DailyPoint {
  /** ISO tarih `yyyy-mm-dd`. */
  tarih: string;
  /** Günlük brüt rezerv nowcast (milyar USD). */
  brutRezerv: number;
  /** NIR = (A02 − A10) / USD / 1e6 (milyar USD); A10 yoksa null. */
  nir: number | null;
}

/**
 * Haftalık dolarizasyon noktası — YP mevduat (milyar USD; ham milyon / 1000).
 * Kaynak: TP.HPBITABLO4.1 (toplam YP mevduat) / TP.HPBITABLO4.2 (yurt içi yerleşik).
 * Not: bu HAFTALIK YP mevduattır; analist günlük DTH'inden (BDDK) farklıdır.
 */
export interface DolarPoint {
  /** ISO tarih `yyyy-mm-dd`. */
  tarih: string;
  /** Toplam YP mevduat (milyar USD) — TP.HPBITABLO4.1 / 1000. */
  ypToplam: number;
  /** Yurt içi yerleşik YP mevduat (milyar USD) — TP.HPBITABLO4.2 / 1000. */
  ypYurtici: number;
}

/** /api/summary yanıt meta'sı (C-001). Faz 2: haftalık + günlük çıpa bağlamı. */
export interface SummaryMeta {
  /** Nowcast çıpası = aralıktaki son resmi haftalık Cuma (ISO). */
  anchorDate: string;
  /** Çıpa günündeki resmi haftalık toplam (milyar USD). */
  anchorBrut: number;
  /** Tüm aralıktaki zirve (en yüksek haftalık toplam). */
  peak: { tarih: string; toplam: number };
  /** En güncel haftalık noktanın tarihi (ISO). */
  latestWeekly: string;
  /** En güncel günlük nowcast noktasının tarihi (ISO). */
  latestDaily: string;
  /** Yanıtın üretildiği an (ISO datetime). */
  updatedAt: string;
  unit: "milyar USD";
  source: "TCMB EVDS";
  /** Bu yanıt KV cache'ten mi geldi. */
  cached: boolean;
  /**
   * Üst akış (EVDS) erişilemediğinde son-bilinen-iyi (last-known-good) veri sunuldu.
   * `updatedAt` bu verinin üretildiği (eski) anı gösterir; UI "X tarihli veri" diyebilir.
   */
  stale?: boolean;
}

/**
 * GET /api/summary yanıt gövdesi (C-001).
 * Faz 3: + `dolarizasyon` (haftalık YP mevduat). EVDS'ten çekilemezse soft-fail ile
 * boş dizi döner (çekirdek haftalık/günlük dashboard düşmez).
 */
export interface SummaryResponse {
  weekly: WeeklyPoint[];
  daily: DailyPoint[];
  dolarizasyon: DolarPoint[];
  meta: SummaryMeta;
}
