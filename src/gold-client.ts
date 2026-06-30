// M-001b gold-client (Faz 6) — HARİCİ (EVDS-DIŞI) günlük altın fiyatı çeker.
// >>> İSTİSNA: "evds-client dışında hiçbir modül EVDS'e dokunmaz" kuralı EVDS içindir.
//     EVDS'te temiz günlük uluslararası altın fiyatı YOK (CLAUDE.md), bu yüzden altın-fiyat
//     etkisi (Faz 6) için tek harici bağımlılık burada izole edilir. Soft-fail: çağıran
//     try/catch ile sarmalar → çekilemezse goldPriceEffect null, çekirdek nowcast düşmez. <<<
// Kaynak: Yahoo Finance v8 chart (GC=F · altın vadeli). Etki ORAN-bazlı olduğundan vadeli↔spot
// baz farkı sadeleşir (research-gold-price-effect.md).

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
