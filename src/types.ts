// M-001..M-004 ortak tipleri. `any` yok; tüm dış değerler buradan geçer.
// Faz 1: HAFTALIK brüt rezerv. Faz 2: + GÜNLÜK nowcast + NIR (`/api/summary`).
// Faz 3: + HAFTALIK dolarizasyon (YP mevduat) `/api/summary.dolarizasyon`.
// Faz 5: + GÜNLÜK swap ayrıştırması (`/api/summary.swap`): Yerli banka SWAPTEKTAR'dan,
//        Yabancı MB DOVVARNC.K18'den (aylık adım, fallback sabiti) → net dış varlık (swap hariç).

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
  /**
   * Çıpadan (son resmi Cuma) beri KÜMÜLATİF altın-fiyat değerleme etkisi (milyar USD, Faz 6):
   *   anchorAltin × ( altınFiyatı(t) / altınFiyatı(çıpa) − 1 )
   * Brüt rezerv değişiminin ne kadarının altın FİYATINDAN (miktar sabit varsayımı) geldiğini
   * verir; kalan (Δbrut − Δaltın etkisi) döviz akışı + FX paritesi + yükümlülüktür.
   * Harici (EVDS-dışı) altın fiyatı çekilemezse `null` (soft-fail). Birim ons: troy.
   */
  goldPriceEffect: number | null;
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

/**
 * Günlük swap ayrıştırması + swap hariç net dış varlık (Faz 5). Hepsi milyar USD.
 * Doğrulanmış yöntem (research-swap-split-method.md):
 *   netDahil  = (TP.AB.A02 − TP.AB.A11 − TP.AB.A14) / USD / 1e6   (≡ NIR + A13)
 *   yerliBanka= (TP.SWAPTEKTAR.TOTALSTOKALIMYONLU − …SATIMYONLU) / 1000   (günlük)
 *   yabanciMb = |TP.DOVVARNC.K18| / 1000   (aylık adım; çekilemezse fallback sabiti)
 *   toplamSwap= yabanciMb + yerliBanka ;  netHaric = netDahil − toplamSwap
 */
export interface SwapPoint {
  /** ISO tarih `yyyy-mm-dd`. */
  tarih: string;
  /** Net dış varlık (swap dahil) — (A02−A11−A14)/USD/1e6. */
  netDahil: number;
  /** Yabancı MB swapı (aylık adım; |K18|/1000 ya da fallback). */
  yabanciMb: number;
  /** Yerli banka swapı (SWAPTEKTAR net stoku, +alım/−satım). */
  yerliBanka: number;
  /** Toplam swap (net, stok) = yabanciMb + yerliBanka. */
  toplamSwap: number;
  /** Net dış varlık (swap hariç) = netDahil − toplamSwap. */
  netHaric: number;
  /**
   * Kamu ve diğer YP mevduatı (analitik bilanço P.1ba = A13) — (A10 − A11 − A14)/USD/1e6, milyar USD
   * (Faz 11). Hazine'nin TCMB'deki döviz hesabı; seviyeden DÜŞÜLMEZ (netDahil ≡ NIR + A13), akımdan
   * düşülür (`FxFlowPoint.kamuDelta`). A10 yoksa `null`.
   */
  kamu: number | null;
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
  /** Swap Yabancı MB bileşeninin kaynağı: K18 aylık serisi mi, fallback sabiti mi (Faz 5). */
  swapMbSource: "evds:K18" | "fallback";
  /** En güncel swap noktasında kullanılan Yabancı MB değeri (milyar USD, Faz 5). */
  swapMb: number;
  /**
   * Altın-fiyat etkisi kaynağı (Faz 6 / Faz 11).
   *   - `evds:altinpiyasa`  : TCMB EVDS BİST Kıymetli Madenler USD/ons ağırlıklı ortalama (iş günü,
   *                            İstanbul seansı; TCMB değerleme referansıyla aynı gün) — TERCİH.
   *   - `external:yahoo-gcf`: Yahoo GC=F vadeli kapanışı (NY; ~6 sa gecikme + ABD tatilleri) — yalnız
   *                            EVDS altın serisi çekilemezse/boşsa FALLBACK.
   *   - `unavailable`       : ikisi de yok → daily[].goldPriceEffect tümü null; çekirdek nowcast düşmez.
   */
  goldPriceSource: "evds:altinpiyasa" | "external:yahoo-gcf" | "unavailable";
  /** Bu yanıt KV cache'ten mi geldi. */
  cached: boolean;
  /**
   * Üst akış (EVDS) erişilemediğinde son-bilinen-iyi (last-known-good) veri sunuldu.
   * `updatedAt` bu verinin üretildiği (eski) anı gösterir; UI "X tarihli veri" diyebilir.
   */
  stale?: boolean;
}

/**
 * Haftalık yurt dışı yerleşiklerin menkul kıymet istatistikleri (Faz 7). Hepsi milyar USD
 * (ham milyon / 1000). Kaynak: EVDS "Yurt Dışı Yerleşiklerin Menkul Kıymet Portföyü"
 * (datagroup `bie_mknethar` · `TP.MKNETHAR.M*`, milyon USD, Cuma). "Yurt İçi Piyasa"
 * alt-kalemleri enstrümandır: hisse M1/M7 · DİBS M2/M8 · ÖST M6/M12 (stok/net).
 * Ayrıca "Yurt Dışı Piyasa" toplamı = eurobond (uluslararası ihraç) M15/M22 (Faz 7b).
 *
 * Her kalem için iki ölçü:
 *   - `*Flow`  = haftalık NET alım-satım (akım); + giriş / − çıkış.
 *   - `*Stock` = piyasa değeriyle toplam stok (pozisyon seviyesi).
 * Akım kısmi/eksik yayımda null yerine 0 normalize edilir.
 */
export interface ForeignSecPoint {
  /** ISO tarih `yyyy-mm-dd`. */
  tarih: string;
  /** Hisse senedi net alım (milyar USD; + giriş / − çıkış). */
  hisseFlow: number;
  /** Hisse senedi stok, piyasa değeriyle (milyar USD). */
  hisseStock: number;
  /** DİBS (Devlet İç Borçlanma Senetleri) net alım (milyar USD). */
  dibsFlow: number;
  /** DİBS stok (milyar USD). */
  dibsStock: number;
  /** ÖST (özel sektör borçlanma senetleri) net alım (milyar USD). */
  ostFlow: number;
  /** ÖST stok (milyar USD). */
  ostStock: number;
  /** Eurobond (Yurt Dışı Piyasa · uluslararası ihraç) net alım (milyar USD) — M22. */
  eurobondFlow: number;
  /** Eurobond (Yurt Dışı Piyasa) stok (milyar USD) — M15. */
  eurobondStock: number;
}

/**
 * Haftalık brüt rezerv değişimi ayrıştırması (Faz 8). Resmi Cuma-Cuma Δbrüt, altın
 * FİYAT değerleme etkisi vs kalan "diğer" (döviz akışı + parite + altın miktar hareketi)
 * olarak bölünür. Yöntem: `computeGoldPriceEffect`'in oran-bazlı yaklaşımının haftalık
 * analoğu (yeni formül DEĞİL). Son eleman devam eden haftanın nowcast kümülatif değişimidir.
 * Hepsi milyar USD.
 */
export interface WeeklyFlowPoint {
  /** Hafta-sonu Cuma (ISO `yyyy-mm-dd`); nowcast'te son günlük nokta tarihi. */
  tarih: string;
  /** Önceki Cuma (ISO); nowcast barında çıpa Cuma. */
  prevTarih: string;
  /** Δbrüt rezerv (toplam_n − toplam_{n-1}); nowcast'te brutRezerv − çıpa.toplam. */
  delta: number;
  /** Altın fiyat değerleme etkisi (altin_{n-1} × (fiyat_n/fiyat_{n-1} − 1)); altın yoksa null. */
  goldPriceEffect: number | null;
  /** delta − goldPriceEffect = döviz akışı + parite (+ altın miktarı); altın yoksa null. */
  otherPart: number | null;
  /** Devam eden hafta (son sütun, nowcast ile hesaplanan kümülatif) → true. */
  nowcast?: boolean;
}

/**
 * Aylık brüt rezerv değişimi ayrıştırması (Faz 9). `WeeklyFlowPoint`'in AYLIK analoğu —
 * `weekly` serisi `yyyy-mm`'e gruplanır, her ay o aydaki SON Cuma ile temsil edilir; ardışık
 * ay-sonu çiftleri için Δbrüt, altın FİYAT değerleme etkisi vs kalan "diğer" (döviz akışı +
 * parite + altın miktar hareketi) olarak bölünür. Yöntem `computeWeeklyFlow` ile birebir
 * simetrik (yeni formül DEĞİL). Son eleman devam eden ayın nowcast kümülatif değişimidir.
 * Hepsi milyar USD.
 */
export interface MonthlyFlowPoint {
  /** Ay anahtarı `yyyy-mm` (temsil eden ay-sonu Cuma'nın ayı); nowcast'te son günlük noktanın ayı. */
  ay: string;
  /** Ay temsilci Cuma (ISO `yyyy-mm-dd`, aydaki son Cuma); nowcast'te son günlük nokta tarihi. */
  tarih: string;
  /** Önceki ay temsilci Cuma (ISO); nowcast barında çıpa (son resmi Cuma). */
  prevTarih: string;
  /** Δbrüt rezerv (toplam_n − toplam_{n-1}); nowcast'te brutRezerv − çıpa.toplam. */
  delta: number;
  /** Altın fiyat değerleme etkisi (altin_{n-1} × (fiyat_n/fiyat_{n-1} − 1)); altın yoksa null. */
  goldPriceEffect: number | null;
  /** delta − goldPriceEffect = döviz akışı + parite (+ altın miktarı); altın yoksa null. */
  otherPart: number | null;
  /** Devam eden ay (son sütun, nowcast ile hesaplanan kümülatif) → true. */
  nowcast?: boolean;
}

/**
 * Günlük NET DÖVİZ ALIMI / SATIMI tahmini (Faz 11). Analist tablolarının standart tanımı
 * ("altın fiyat etkisi hariç net alım", N^fp): swap hariç net dış varlığın günlük değişiminden
 * TCMB'nin piyasa işlemi OLMAYAN kalemler ayıklanır. Hepsi milyar USD; `tarih` = dönem SONU
 * (prevTarih → tarih kapanışı; analist tabloları çoğunlukla dönem BAŞI etiketler — bir gün kaydırın).
 *
 *   deltaNetHaric   = netHaric_n − netHaric_{n-1}                     (ham Δ swap hariç net)
 *   goldPriceEffect = altin(F)/fiyat(F) × (fiyat_n − fiyat_{n-1})     (Laspeyres; F = prevTarih'e en
 *                                                                      yakın önceki resmi Cuma = ima edilen ons)
 *   kamuDelta       = kamu_n − kamu_{n-1}                              (Hazine döviz hesabı hareketi, A13)
 *   swapRevision    = −(yabanciMb_n − yabanciMb_{n-1})                 (Yabancı MB bacağı aylık adımı —
 *                                                                      işlem değil, geç gelen bilgi)
 *   fxFlow          = deltaNetHaric − goldPriceEffect − kamuDelta − swapRevision
 *                   ≡ ΔnetDahil − ΔyerliBanka − Γ − ΔKamu
 *
 * Kimlik: deltaNetHaric = fxFlow + goldPriceEffect + kamuDelta + swapRevision (tanım gereği kapanır).
 * fxFlow altın MİKTAR hareketini (TCMB altın alım/satımı) ve döviz paritesini İÇERİR (piyasa
 * tablolarıyla aynı konvansiyon; günlük ons verisi EVDS'te yok). Her iki günün altın fiyatı
 * yoksa (tatil/yayım gecikmesi) gold ve fxFlow `null` — SIFIR YAZILMAZ. Doğrulama: bağımsız
 * analist serisiyle 5/5 gün ≤0,07 mlr (2026-09-04..11).
 */
export interface FxFlowPoint {
  /** Dönem sonu (ISO `yyyy-mm-dd`) — bar bu güne etiketlenir. */
  tarih: string;
  /** Dönem başı (ISO) — bir önceki mevcut iş günü. */
  prevTarih: string;
  /** Δ swap hariç net dış varlık (ham; netHaric_n − netHaric_{n-1}). */
  deltaNetHaric: number;
  /** Altın FİYAT değerleme etkisi (Laspeyres, ima edilen ons); fiyat yoksa null. */
  goldPriceEffect: number | null;
  /** Kamu (Hazine) YP mevduatı hareketi (A13); A10 yoksa null. */
  kamuDelta: number | null;
  /** Yabancı MB swap çapa revizyonu (−ΔyabanciMb); 0 dışında yalnız ay adımında. */
  swapRevision: number;
  /** Net döviz alımı(+)/satımı(−) tahmini; gold ya da kamu null ise null. */
  fxFlow: number | null;
}

/**
 * GET /api/summary yanıt gövdesi (C-001).
 * Faz 3: + `dolarizasyon` (haftalık YP mevduat). Faz 5: + `swap` (günlük swap ayrıştırması).
 * Faz 7: + `foreignSecurities` (haftalık yurt dışı yerleşik menkul kıymet akım+stok).
 * Faz 8: + `weeklyFlow` (haftalık rezerv değişimi: altın fiyat etkisi vs diğer + nowcast son sütun).
 * Faz 9: + `monthlyFlow` (aylık rezerv değişimi; weeklyFlow'un aylık analoğu + nowcast son sütun).
 * Faz 11: + `fxFlow` (günlük net döviz alımı/satımı tahmini; `swap` artık [start,end] tam aralık).
 * Hepsi EVDS'ten çekilemezse soft-fail ile boş dizi döner (çekirdek haftalık/günlük dashboard düşmez).
 */
export interface SummaryResponse {
  weekly: WeeklyPoint[];
  daily: DailyPoint[];
  dolarizasyon: DolarPoint[];
  swap: SwapPoint[];
  foreignSecurities: ForeignSecPoint[];
  weeklyFlow: WeeklyFlowPoint[];
  monthlyFlow: MonthlyFlowPoint[];
  fxFlow: FxFlowPoint[];
  meta: SummaryMeta;
}

/**
 * E-posta gönderim mesajı (Faz 10 — M-006). Cloudflare Email Service `send_email`
 * binding'inin object-form `send()` API'sinin (2026-04) dar yapısal karşılığı;
 * `@cloudflare/workers-types` sürümümüz bu formu henüz bilmediğinden burada tanımlanır
 * (strict-güvenli; testte kolayca mock'lanır).
 */
export interface EmailSendMessage {
  /** Alıcı; verilmezse binding'in `destination_address` değeri kullanılır. */
  to?: string;
  /** Gönderen — Email Routing etkin domain'de bir adres olmalı (ör. rezerv@tqrlab.com). */
  from: string | { email: string; name?: string };
  subject: string;
  /** Düz metin gövde (Bloomberg chat'e yapıştırılabilir; HTML kullanılmaz). */
  text: string;
}

/** `send_email` binding yüzeyi (object-form). Hata durumunda `E_*` kodlu Error fırlatır. */
export interface EmailSender {
  send(msg: EmailSendMessage): Promise<{ messageId: string }>;
}

/** Mail dili (Faz 10): yalnız İngilizce, yalnız Türkçe ya da ikisi bir gövdede (EN üstte). */
export type EmailLang = "en" | "tr" | "both";
