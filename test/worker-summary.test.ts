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
// A11/A14 (Faz 5 swap net dış varlık için) eklendi — nowcast/NIR'i etkilemez (A02/A10/USD kullanır).
const DAILY_ITEMS = [
  { Tarih: "12-06-2026", TP_AB_A02: "6400000000", TP_AB_A10: "4600000000", TP_AB_A11: "100000000", TP_AB_A14: "2000000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "17-06-2026", TP_AB_A02: "6884800000", TP_AB_A10: "4650000000", TP_AB_A11: "100000000", TP_AB_A14: "2000000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "18-06-2026", TP_AB_A02: "6692800000", TP_AB_A10: "4660000000", TP_AB_A11: "100000000", TP_AB_A14: "2000000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "19-06-2026", TP_AB_A02: "6600800000", TP_AB_A10: "4672800000", TP_AB_A11: "100000000", TP_AB_A14: "2000000000", TP_DK_USD_A_YTL: "40" },
];
// Faz 3 — haftalık YP mevduat (dolarizasyon). Kabul: 12-06 -> 262.1 / 222.0.
const DOLAR_ITEMS = [
  { Tarih: "27-02-2026", TP_HPBITABLO4_1: "250000", TP_HPBITABLO4_2: "210000" },
  { Tarih: "12-06-2026", TP_HPBITABLO4_1: "262100", TP_HPBITABLO4_2: "222000" },
];
// Faz 5 — swap ayrıştırması. SWAPTEKTAR günlük (yerli banka), DOVVARNC.K18 aylık (yabancı MB).
const SWAP_ITEMS = [
  { Tarih: "12-06-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: "3185", TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: "1526" },
  { Tarih: "17-06-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: "3000", TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: "1500" },
  { Tarih: "18-06-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: "2800", TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: "1400" },
  { Tarih: "19-06-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: "2600", TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: "1300" },
];
const MB_ITEMS = [
  { Tarih: "2026-5", TP_DOVVARNC_K18: "-16360" },
  { Tarih: "2026-6", TP_DOVVARNC_K18: "-16310" }, // Haziran -> 16.31
];
// Faz 7 — yurt dışı yerleşik menkul kıymet (haftalık). Ham milyon USD → /1000 (milyar).
//   Kabul: 12-06 hisse net 0.2931 / DİBS net −0.3348 / ÖST net 0.0365 ; stok 24 / 11 / 0.9.
const FOREIGN_SEC_ITEMS = [
  {
    Tarih: "05-06-2026",
    TP_MK_YDY_HISSE_NET: "150", TP_MK_YDY_HISSE_STOK: "23900",
    TP_MK_YDY_DIBS_NET: "60", TP_MK_YDY_DIBS_STOK: "11100",
    TP_MK_YDY_OST_NET: "12", TP_MK_YDY_OST_STOK: "890",
  },
  {
    Tarih: "12-06-2026",
    TP_MK_YDY_HISSE_NET: "293.1", TP_MK_YDY_HISSE_STOK: "24000",
    TP_MK_YDY_DIBS_NET: "-334.8", TP_MK_YDY_DIBS_STOK: "11000",
    TP_MK_YDY_OST_NET: "36.5", TP_MK_YDY_OST_STOK: "900",
  },
];

// Faz 6 — harici altın fiyatı (Yahoo GC=F chart). Çıpa 12-06 fiyat 4000; 19-06 4040.
//   anchorAltin = C1(12-06)/1000 = 72.08 → etki_19 = 72.08×(4040/4000−1) = 0.7208.
const GOLD_ENTRIES: [string, number][] = [
  ["2026-06-12", 4000],
  ["2026-06-17", 4200],
  ["2026-06-18", 4100],
  ["2026-06-19", 4040],
];
function goldChartResponse(entries: [string, number][]): Response {
  const timestamp = entries.map(([iso]) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Math.floor(Date.UTC(y!, m! - 1, d!) / 1000);
  });
  const close = entries.map(([, p]) => p);
  return jsonResponse({ chart: { result: [{ timestamp, indicators: { quote: [{ close }] } }] } });
}

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
    if (url.includes("yahoo.com")) return Promise.resolve(goldChartResponse(GOLD_ENTRIES));
    if (url.includes("TP.SWAPTEKTAR")) return Promise.resolve(jsonResponse({ items: SWAP_ITEMS }));
    if (url.includes("TP.DOVVARNC")) return Promise.resolve(jsonResponse({ items: MB_ITEMS }));
    if (url.includes("TP.MK.YDY")) return Promise.resolve(jsonResponse({ items: FOREIGN_SEC_ITEMS }));
    if (url.includes("TP.AB.A02")) return Promise.resolve(jsonResponse({ items: DAILY_ITEMS }));
    if (url.includes("TP.HPBITABLO4.1")) return Promise.resolve(jsonResponse({ items: DOLAR_ITEMS }));
    return Promise.resolve(jsonResponse({ items: WEEKLY_ITEMS }));
  }) as typeof fetch;
}

/** Altın fiyatı (Yahoo) çağrısı 500 döner -> gold soft-fail (goldPriceEffect null, kaynak unavailable). */
function mockFetchGoldFails(): typeof fetch {
  return ((input: Request | string | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("yahoo.com")) return Promise.resolve(new Response("err", { status: 500 }));
    if (url.includes("TP.SWAPTEKTAR")) return Promise.resolve(jsonResponse({ items: SWAP_ITEMS }));
    if (url.includes("TP.DOVVARNC")) return Promise.resolve(jsonResponse({ items: MB_ITEMS }));
    if (url.includes("TP.MK.YDY")) return Promise.resolve(jsonResponse({ items: FOREIGN_SEC_ITEMS }));
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
    if (url.includes("TP.SWAPTEKTAR")) return Promise.resolve(jsonResponse({ items: SWAP_ITEMS }));
    if (url.includes("TP.DOVVARNC")) return Promise.resolve(jsonResponse({ items: MB_ITEMS }));
    if (url.includes("TP.MK.YDY")) return Promise.resolve(jsonResponse({ items: FOREIGN_SEC_ITEMS }));
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

/** Swap (SWAPTEKTAR) çağrısı HTML döndürür -> fetchSeries fırlatır -> swap soft-fail ([]). */
function mockFetchSwapFails(): typeof fetch {
  return ((input: Request | string | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("TP.SWAPTEKTAR")) {
      return Promise.resolve(new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    }
    if (url.includes("TP.DOVVARNC")) return Promise.resolve(jsonResponse({ items: MB_ITEMS }));
    if (url.includes("TP.MK.YDY")) return Promise.resolve(jsonResponse({ items: FOREIGN_SEC_ITEMS }));
    if (url.includes("TP.AB.A02")) return Promise.resolve(jsonResponse({ items: DAILY_ITEMS }));
    if (url.includes("TP.HPBITABLO4.1")) return Promise.resolve(jsonResponse({ items: DOLAR_ITEMS }));
    return Promise.resolve(jsonResponse({ items: WEEKLY_ITEMS }));
  }) as typeof fetch;
}

/** Yurt dışı menkul kıymet (TP.MK.YDY) çağrısı HTML döndürür -> fetchSeries fırlatır ->
 *  foreignSecurities soft-fail ([]); haftalık/günlük/dolarizasyon/swap etkilenmez. */
function mockFetchForeignSecFails(): typeof fetch {
  return ((input: Request | string | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("TP.MK.YDY")) {
      return Promise.resolve(new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    }
    if (url.includes("yahoo.com")) return Promise.resolve(goldChartResponse(GOLD_ENTRIES));
    if (url.includes("TP.SWAPTEKTAR")) return Promise.resolve(jsonResponse({ items: SWAP_ITEMS }));
    if (url.includes("TP.DOVVARNC")) return Promise.resolve(jsonResponse({ items: MB_ITEMS }));
    if (url.includes("TP.AB.A02")) return Promise.resolve(jsonResponse({ items: DAILY_ITEMS }));
    if (url.includes("TP.HPBITABLO4.1")) return Promise.resolve(jsonResponse({ items: DOLAR_ITEMS }));
    return Promise.resolve(jsonResponse({ items: WEEKLY_ITEMS }));
  }) as typeof fetch;
}

/** Tüm EVDS çağrıları 503 HTML döndürür (TCMB planlı bakım senaryosu). */
function mockFetchMaintenance(): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(
        "<html><body>Scheduled maintenance in progress between 00:00-02:00 (GMT +3)</body></html>",
        { status: 503, headers: { "content-type": "text/html" } },
      ),
    )) as typeof fetch;
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
      daily: { tarih: string; brutRezerv: number; nir: number | null; goldPriceEffect: number | null }[];
      dolarizasyon: { tarih: string; ypToplam: number; ypYurtici: number }[];
      swap: {
        tarih: string;
        netDahil: number;
        yabanciMb: number;
        yerliBanka: number;
        toplamSwap: number;
        netHaric: number;
      }[];
      foreignSecurities: {
        tarih: string;
        hisseFlow: number;
        hisseStock: number;
        dibsFlow: number;
        dibsStock: number;
        ostFlow: number;
        ostStock: number;
      }[];
      meta: {
        anchorDate: string;
        anchorBrut: number;
        peak: { tarih: string; toplam: number };
        latestWeekly: string;
        latestDaily: string;
        unit: string;
        source: string;
        swapMbSource: string;
        swapMb: number;
        goldPriceSource: string;
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

    // swap (Faz 5) — 4 nokta (12/17/18/19-06); kimlikler + 19-06 değerleri.
    assert.ok(Array.isArray(body.swap), "swap dizi");
    assert.equal(body.swap.length, 4, "4 swap noktası");
    for (const p of body.swap) {
      assert.ok(Math.abs(p.toplamSwap - (p.yabanciMb + p.yerliBanka)) < 1e-6, "toplam = ymb + yerli");
      assert.ok(Math.abs(p.netHaric - (p.netDahil - p.toplamSwap)) < 1e-6, "netHaric = netDahil − toplam");
    }
    const swap19 = body.swap.find((s) => s.tarih === "2026-06-19");
    assert.ok(swap19, "19-06 swap noktası var");
    // 19-06: yerli=(2600−1300)/1000=1.3 ; ymb=|−16310|/1000=16.31 (Haziran K18) ; toplam=17.61
    assert.ok(Math.abs(swap19!.yerliBanka - 1.3) < 1e-6, "yerli 1.3");
    assert.ok(Math.abs(swap19!.yabanciMb - 16.31) < 1e-9, "ymb 16.31");
    assert.ok(Math.abs(swap19!.toplamSwap - 17.61) < 1e-6, "toplam 17.61");
    assert.equal(body.meta.swapMbSource, "evds:K18");
    assert.ok(Math.abs(body.meta.swapMb - 16.31) < 1e-9, "meta.swapMb 16.31");

    // foreignSecurities (Faz 7) — 2 nokta (05/12-06); artan sıra + 12-06 değerleri (/1000, işaret).
    assert.ok(Array.isArray(body.foreignSecurities), "foreignSecurities dizi");
    assert.equal(body.foreignSecurities.length, 2, "2 foreignSecurities noktası");
    assert.equal(body.foreignSecurities[0]!.tarih, "2026-06-05", "artan sıra");
    const fs12 = body.foreignSecurities.find((f) => f.tarih === "2026-06-12");
    assert.ok(fs12, "12-06 foreignSecurities noktası var");
    assert.ok(Math.abs(fs12!.hisseFlow - 0.2931) < 1e-9, "hisse net 0.2931");
    assert.ok(Math.abs(fs12!.dibsFlow - -0.3348) < 1e-9, "DİBS net −0.3348 (satış negatif)");
    assert.ok(Math.abs(fs12!.ostFlow - 0.0365) < 1e-9, "ÖST net 0.0365");
    assert.equal(fs12!.hisseStock, 24, "hisse stok 24");
    assert.equal(fs12!.dibsStock, 11, "DİBS stok 11");
    assert.equal(fs12!.ostStock, 0.9, "ÖST stok 0.9");

    // daily nowcast (kabul)
    const byDate = new Map(body.daily.map((d) => [d.tarih, d]));
    assert.ok(Math.abs(byDate.get("2026-06-17")!.brutRezerv - 164.2) < 0.1);
    assert.ok(Math.abs(byDate.get("2026-06-18")!.brutRezerv - 159.4) < 0.1);
    assert.ok(Math.abs(byDate.get("2026-06-19")!.brutRezerv - 157.1) < 0.1);
    assert.ok(Math.abs((byDate.get("2026-06-19")!.nir ?? 0) - 48.2) < 0.1);
    assert.ok(body.daily.every((d) => d.nir !== null), "NIR her noktada dolu");

    // altın-fiyat etkisi (Faz 6) — çıpa 12-06 fiyat 4000 → etki 0; 19-06 = 72.08×(4040/4000−1)=0.7208.
    assert.equal(body.meta.goldPriceSource, "external:yahoo-gcf", "altın kaynağı external");
    const gpe = new Map(body.daily.map((d) => [d.tarih, d.goldPriceEffect]));
    assert.ok(Math.abs((gpe.get("2026-06-12") ?? -1) - 0) < 1e-6, "çıpada altın etkisi 0");
    assert.ok(Math.abs((gpe.get("2026-06-19") ?? 0) - 0.7208) < 1e-4, "19-06 altın etkisi 0.7208");

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

test("/api/summary: EVDS bakımda (503) + son-bilinen-iyi var -> 200 stale", async () => {
  const original = globalThis.fetch;
  const { env, store } = makeEnv();
  try {
    // 1) Başarılı istek son-bilinen-iyi havuzunu doldurur.
    globalThis.fetch = mockFetch();
    const ok = await callSummary(env);
    assert.equal(ok.status, 200);
    assert.ok([...store.keys()].some((k) => k.startsWith("summary:last:")), "last-good yazıldı");

    // 2) EVDS bakıma girer; date-specific cache'i farklı end ile baypas et → build çağrılır.
    globalThis.fetch = mockFetchMaintenance();
    const req = new Request(
      "https://worker.test/api/summary?weeklyStart=01-10-2025&end=28-06-2026",
    );
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200, "EVDS bakımda olsa da dashboard ayakta (stale)");
    const body = (await res.json()) as {
      weekly: unknown[];
      meta: { cached: boolean; stale?: boolean };
    };
    assert.equal(body.meta.stale, true, "stale damgası");
    assert.equal(body.meta.cached, true);
    assert.ok(body.weekly.length > 0, "stale veride haftalık dolu");
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/summary: EVDS bakımda (503) + son-bilinen-iyi YOK -> 502 evds_unavailable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchMaintenance();
  try {
    const { env } = makeEnv();
    const res = await callSummary(env);
    assert.equal(res.status, 502, "fallback yoksa tanımlı hata döner");
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "evds_unavailable", "503 -> evds_unavailable (auth değil)");
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

test("/api/summary: swap başarısız -> soft-fail ([]) + meta.swapMbSource=fallback, 200 + diğerleri dolu", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSwapFails();
  try {
    const { env } = makeEnv();
    const res = await callSummary(env);
    assert.equal(res.status, 200, "swap hatası tüm summary'yi düşürmemeli");
    const body = (await res.json()) as {
      weekly: unknown[];
      daily: unknown[];
      dolarizasyon: unknown[];
      swap: unknown[];
      meta: { swapMbSource: string; swapMb: number };
    };
    assert.ok(Array.isArray(body.swap) && body.swap.length === 0, "swap []");
    assert.equal(body.meta.swapMbSource, "fallback", "soft-fail -> fallback");
    assert.ok(Math.abs(body.meta.swapMb - 16.4) < 1e-9, "fallback 16.4");
    assert.ok(body.weekly.length > 0 && body.daily.length > 0, "haftalık/günlük dolu");
    assert.ok(body.dolarizasyon.length > 0, "dolarizasyon dolu");
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/summary: foreignSecurities başarısız -> soft-fail ([]) + 200 + diğerleri dolu", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchForeignSecFails();
  try {
    const { env } = makeEnv();
    const res = await callSummary(env);
    assert.equal(res.status, 200, "foreignSecurities hatası tüm summary'yi düşürmemeli");
    const body = (await res.json()) as {
      weekly: unknown[];
      daily: unknown[];
      dolarizasyon: unknown[];
      swap: unknown[];
      foreignSecurities: unknown[];
    };
    assert.ok(
      Array.isArray(body.foreignSecurities) && body.foreignSecurities.length === 0,
      "foreignSecurities []",
    );
    assert.ok(body.weekly.length > 0 && body.daily.length > 0, "haftalık/günlük dolu");
    assert.ok(body.dolarizasyon.length > 0 && body.swap.length > 0, "dolarizasyon/swap dolu");
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/summary: altın fiyatı başarısız -> soft-fail (goldPriceEffect null) + 200 + diğerleri dolu", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchGoldFails();
  try {
    const { env } = makeEnv();
    const res = await callSummary(env);
    assert.equal(res.status, 200, "altın hatası tüm summary'yi düşürmemeli");
    const body = (await res.json()) as {
      daily: { goldPriceEffect: number | null }[];
      weekly: unknown[];
      meta: { goldPriceSource: string };
    };
    assert.equal(body.meta.goldPriceSource, "unavailable", "soft-fail -> unavailable");
    assert.ok(body.daily.every((d) => d.goldPriceEffect === null), "goldPriceEffect tümü null");
    assert.ok(body.daily.length > 0 && body.weekly.length > 0, "haftalık/günlük hâlâ dolu");
  } finally {
    globalThis.fetch = original;
  }
});
