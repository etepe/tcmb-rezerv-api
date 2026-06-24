// M-005 scheduled-refresh (Faz 4) — Cloudflare Cron Trigger ile KV cache ön-ısıtma.
// UI'nin (ve CI smoke'unun) düştüğü anahtarları periyodik tazeler: summary + weekly.
// Public sözleşmeyi DEĞİŞTİRMEZ; yalnız cache'i ısıtır → kullanıcı hep SICAK cache'e düşer
// (Faz 3'teki "bayat cache → smoke fail" sınıfı sorunu kökten kapatır).
// EVDS'i dövmez: wrangler.toml [triggers] mütevazı sıklıkta tetikler (hafta içi birkaç kez + Cuma).
// Anahtar/sır LOGLANMAZ. buildSummary/buildWeekly HTTP handler ile aynı saf yolu paylaşır (kopya yok).

import {
  buildSummary,
  buildWeekly,
  defaultStart,
  type Env,
  summaryKey,
  todayDdMmYyyy,
  weeklyKey,
  writeSummaryCache,
  writeWeeklyCache,
} from "./summary.ts";

/**
 * Cron çekirdeği: varsayılan aralık için summary + weekly cache'ini TAZELER.
 *   start = DEFAULT_WEEKLY_START ?? FALLBACK_START, end = bugün (UTC) — UI anahtarıyla birebir.
 *
 * İki ön-ısıtma birbirinden bağımsız (Promise.allSettled): biri EVDS hatası alsa da
 * diğeri yine de yazılır; cron handler ASLA fırlatmaz (hata yalnız loglanır).
 */
export async function warmCache(env: Env): Promise<void> {
  const start = defaultStart(env);
  const end = todayDdMmYyyy();

  const results = await Promise.allSettled([
    buildSummary(env, start, end).then((p) => writeSummaryCache(env, start, end, p)),
    buildWeekly(env, start, end).then((p) => writeWeeklyCache(env, start, end, p)),
  ]);

  const keys = [summaryKey(start, end), weeklyKey(start, end)];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      // Tanımlı hata mesajı; anahtar/sır içermez (EvdsError/EngineError mesajları güvenli).
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[scheduled] ön-ısıtma başarısız (${keys[i]}): ${reason}`);
    } else {
      console.log(`[scheduled] ön-ısıtıldı: ${keys[i]}`);
    }
  });
}
