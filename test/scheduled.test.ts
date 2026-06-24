// M-005 offline entegrasyon testi — cron ön-ısıtma (Faz 4). Ağ/secret gerekmez.
// globalThis.fetch (EVDS) + sahte KVNamespace mock'lanır; gerçek worker.scheduled handler
// (→ warmCache → buildSummary/buildWeekly → write*Cache) çağrılır.
// Kabul: cron summary + weekly anahtarını doldurur (dolarizasyon dahil); cron SONRASI
// ilk /api/summary isteği EVDS'e GİTMEDEN cache'ten gelir (cached=true).
// Çalıştır: node --test --experimental-strip-types
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/index.ts";
import { summaryKey, todayDdMmYyyy, weeklyKey } from "../src/summary.ts";

// --- EVDS yanıt mock'u (worker-summary.test.ts ile aynı kabul değerleri) ---
const WEEKLY_ITEMS = [
  { Tarih: "27-02-2026", TP_AB_TOPLAM: "210300", TP_AB_C2: "73400", TP_AB_C1: "136800" },
  { Tarih: "12-06-2026", TP_AB_TOPLAM: "152080", TP_AB_C2: "80000", TP_AB_C1: "72080" },
];
const DAILY_ITEMS = [
  { Tarih: "12-06-2026", TP_AB_A02: "6400000000", TP_AB_A10: "4600000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "17-06-2026", TP_AB_A02: "6884800000", TP_AB_A10: "4650000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "18-06-2026", TP_AB_A02: "6692800000", TP_AB_A10: "4660000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "19-06-2026", TP_AB_A02: "6600800000", TP_AB_A10: "4672800000", TP_DK_USD_A_YTL: "40" },
];
const DOLAR_ITEMS = [
  { Tarih: "27-02-2026", TP_HPBITABLO4_1: "250000", TP_HPBITABLO4_2: "210000" },
  { Tarih: "12-06-2026", TP_HPBITABLO4_1: "262100", TP_HPBITABLO4_2: "222000" },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** series=... içeriğine göre haftalık / günlük / dolarizasyon item'ları döndürür. */
function mockFetch(): typeof fetch {
  return ((input: Request | string | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("TP.AB.A02")) return Promise.resolve(jsonResponse({ items: DAILY_ITEMS }));
    if (url.includes("TP.HPBITABLO4.1")) return Promise.resolve(jsonResponse({ items: DOLAR_ITEMS }));
    return Promise.resolve(jsonResponse({ items: WEEKLY_ITEMS }));
  }) as typeof fetch;
}

/** Map tabanlı sahte KVNamespace (yalnız get/put kullanılır). */
function makeEnv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  const env: Env = {
    TCMB_EVDS_KEY: "test-key-never-logged",
    REZERV_CACHE: kv,
    WEEKLY_TTL: "21600",
    DAILY_TTL: "3600",
    DEFAULT_WEEKLY_START: "01-10-2025",
  };
  return { env, store };
}

/** Minimal ScheduledController / ExecutionContext stub (handler bunları kullanmaz). */
function fakeController(cron: string): ScheduledController {
  return { cron, scheduledTime: 0, noRetry() {} } as unknown as ScheduledController;
}
function fakeCtx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

interface SummaryShape {
  weekly: { tarih: string; toplam: number }[];
  daily: { tarih: string; brutRezerv: number; nir: number | null }[];
  dolarizasyon: { tarih: string; ypToplam: number; ypYurtici: number }[];
  meta: { cached: boolean; anchorDate: string };
}

test("scheduled: cron summary + weekly cache'ini doldurur (dolarizasyon dahil), sır sızmaz", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const { env, store } = makeEnv();
    await worker.scheduled(fakeController("0 8,12,16 * * 1-5"), env, fakeCtx());

    const start = "01-10-2025";
    const end = todayDdMmYyyy();
    const sKey = summaryKey(start, end);
    const wKey = weeklyKey(start, end);

    assert.ok(store.has(sKey), `summary anahtarı yazıldı (${sKey})`);
    assert.ok(store.has(wKey), `weekly anahtarı yazıldı (${wKey})`);

    const summary = JSON.parse(store.get(sKey)!) as SummaryShape;
    assert.ok(summary.weekly.length > 0, "haftalık dolu");
    assert.ok(summary.daily.length > 0, "günlük nowcast dolu");
    // Dolarizasyon ön-ısıtmaya dahil (Faz 3 alanı): 12-06 -> 262.1 / 222.0.
    assert.equal(summary.dolarizasyon.length, 2, "dolarizasyon ön-ısıtıldı");
    const dolar12 = summary.dolarizasyon.find((d) => d.tarih === "2026-06-12");
    assert.ok(dolar12 && Math.abs(dolar12.ypToplam - 262.1) < 0.01, "dolarizasyon değeri doğru");
    // KV'ye yazılan kopya cached=true damgalı.
    assert.equal(summary.meta.cached, true, "cache kopyası cached=true");
    // EVDS anahtarı cache gövdesine sızmamalı.
    assert.ok(!store.get(sKey)!.includes("test-key-never-logged"), "secret cache'e sızmadı");
  } finally {
    globalThis.fetch = original;
  }
});

test("scheduled: cron SONRASI ilk /api/summary isteği EVDS'e gitmeden cache'ten gelir", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const { env } = makeEnv();
    // 1) Cron ön-ısıtır.
    await worker.scheduled(fakeController("0 17 * * 5"), env, fakeCtx());

    // 2) Cron sonrası EVDS'e gidilmemeli — fetch'i fırlatıcıya çevir.
    globalThis.fetch = (() => {
      throw new Error("cron sonrası ilk istek EVDS'e GİTMEMELİ (sıcak cache bekleniyor)");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(
      new Request("https://worker.test/api/summary?weeklyStart=01-10-2025"),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as SummaryShape;
    assert.equal(body.meta.cached, true, "cron sonrası ilk istek cached=true");
    assert.equal(body.meta.anchorDate, "2026-06-12");
  } finally {
    globalThis.fetch = original;
  }
});
