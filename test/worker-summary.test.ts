// M-003 offline entegrasyon testi — /api/summary uçtan uca (ağ/secret gerekmez).
// globalThis.fetch (EVDS) ve KVNamespace mock'lanır; gerçek worker handler çağrılır.
// Kabul: çıpa 12-06 = 152.08; nowcast 17/18/19-06 = 164.2/159.4/157.1; NIR_19 ≈ 48.2.
// Çalıştır: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/index.ts";

// --- EVDS yanıt mock'u (items: nokta -> alt çizgi anahtarlar, değerler string) ---
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
// Faz 3 — haftalık YP mevduat (dolarizasyon). Kabul: 12-06 -> 262.1 / 222.0.
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

/** Dolarizasyon çağrısı HTML döndürür (auth/uç hatası) -> fetchSeries fırlatır.
 *  Soft-fail testinde haftalık/günlük başarılı, dolarizasyon başarısız senaryosu. */
function mockFetchDolarFails(): typeof fetch {
  return ((input: Request | string | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("TP.AB.A02")) return Promise.resolve(jsonResponse({ items: DAILY_ITEMS }));
    if (url.includes("TP.HPBITABLO4.1")) {
      return Promise.resolve(new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    }
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

async function callSummary(env: Env) {
  const req = new Request("https://worker.test/api/summary?weeklyStart=01-10-2025");
  return worker.fetch(req, env);
}

test("/api/summary: shape + nowcast kabul + meta", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const { env } = makeEnv();
    const res = await callSummary(env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      weekly: { tarih: string; toplam: number }[];
      daily: { tarih: string; brutRezerv: number; nir: number | null }[];
      dolarizasyon: { tarih: string; ypToplam: number; ypYurtici: number }[];
      meta: {
        anchorDate: string;
        anchorBrut: number;
        peak: { tarih: string; toplam: number };
        latestWeekly: string;
        latestDaily: string;
        unit: string;
        source: string;
        cached: boolean;
      };
    };

    // weekly
    assert.equal(body.weekly.length, 2);
    assert.ok(Math.abs(body.weekly[1]!.toplam - 152.08) < 0.01);

    // dolarizasyon (Faz 3) — kabul: 12-06 -> 262.1 / 222.0
    assert.ok(Array.isArray(body.dolarizasyon), "dolarizasyon dizi");
    assert.equal(body.dolarizasyon.length, 2);
    const dolar12 = body.dolarizasyon.find((d) => d.tarih === "2026-06-12");
    assert.ok(dolar12, "12-06 dolarizasyon noktası var");
    assert.ok(Math.abs(dolar12!.ypToplam - 262.1) < 0.01, "ypToplam 262.1");
    assert.ok(Math.abs(dolar12!.ypYurtici - 222.0) < 0.01, "ypYurtici 222.0");

    // daily nowcast (kabul)
    const byDate = new Map(body.daily.map((d) => [d.tarih, d]));
    assert.ok(Math.abs(byDate.get("2026-06-17")!.brutRezerv - 164.2) < 0.1);
    assert.ok(Math.abs(byDate.get("2026-06-18")!.brutRezerv - 159.4) < 0.1);
    assert.ok(Math.abs(byDate.get("2026-06-19")!.brutRezerv - 157.1) < 0.1);
    assert.ok(Math.abs((byDate.get("2026-06-19")!.nir ?? 0) - 48.2) < 0.1);
    assert.ok(body.daily.every((d) => d.nir !== null), "NIR her noktada dolu");

    // meta
    assert.equal(body.meta.anchorDate, "2026-06-12");
    assert.ok(Math.abs(body.meta.anchorBrut - 152.08) < 0.01);
    assert.equal(body.meta.peak.tarih, "2026-02-27");
    assert.ok(Math.abs(body.meta.peak.toplam - 210.3) < 0.01);
    assert.equal(body.meta.latestWeekly, "2026-06-12");
    assert.equal(body.meta.latestDaily, "2026-06-19");
    assert.equal(body.meta.unit, "milyar USD");
    assert.equal(body.meta.source, "TCMB EVDS");
    assert.equal(body.meta.cached, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/summary: ikinci istek KV cache'ten (cached=true), gövde sızıntısı yok", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const { env } = makeEnv();
    await callSummary(env); // 1) miss -> KV put
    const res2 = await callSummary(env); // 2) hit
    const body = (await res2.json()) as { meta: { cached: boolean } };
    assert.equal(body.meta.cached, true);
    // EVDS anahtarı yanıtta görünmemeli.
    assert.ok(!JSON.stringify(body).includes("test-key-never-logged"));
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/summary: bilinmeyen uç -> 404 not_found", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request("https://worker.test/api/nope"), env);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "not_found");
});

test("/api/summary: dolarizasyon başarısız -> soft-fail ([]) ama 200 + weekly/daily dolu", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchDolarFails();
  try {
    const { env } = makeEnv();
    const res = await callSummary(env);
    assert.equal(res.status, 200, "dolarizasyon hatası tüm summary'yi düşürmemeli");
    const body = (await res.json()) as {
      weekly: unknown[];
      daily: unknown[];
      dolarizasyon: unknown[];
    };
    assert.ok(Array.isArray(body.dolarizasyon) && body.dolarizasyon.length === 0, "dolarizasyon []");
    assert.ok(body.weekly.length > 0, "haftalık hâlâ dolu");
    assert.ok(body.daily.length > 0, "günlük hâlâ dolu");
  } finally {
    globalThis.fetch = original;
  }
});
