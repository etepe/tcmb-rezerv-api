// M-006 offline testleri — günlük rezerv-akışı maili (Faz 10). Ağ/secret/binding gerekmez.
// 1) buildReserveEmail SAF üretim: EN/TR/both, işaret+1 ondalık, gold-null tek-mod,
//    stale işareti, nowcast satırı yoksa "n/a".
// 2) Dispatch: gerçek worker.scheduled EMAIL_CRON tetiğinde mock sender ile TAM 1 mail
//    gönderir (sıcak cache'te EVDS'e GİTMEDEN); miss'te build+ısıtma; build hatasında
//    son-bilinen-iyi (stale) mail; hiç veri yoksa gönderim yok ve fırlatmaz.
// Çalıştır: node --test --experimental-strip-types
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/index.ts";
import { buildReserveEmail } from "../src/email.ts";
import { summaryKey, summaryLastKey, todayDdMmYyyy } from "../src/summary.ts";
import type {
  EmailSender,
  EmailSendMessage,
  MonthlyFlowPoint,
  SummaryMeta,
  SummaryResponse,
  WeeklyFlowPoint,
} from "../src/types.ts";

const NOW = new Date("2026-08-04T05:30:00Z");
const EMAIL_CRON = "30 5,12 * * 1-5";
const START = "01-10-2025";

/** Elle kurulan SummaryResponse fixture'ı (builder testleri girdiyi TAM kontrol eder). */
function makeSummary(overrides?: {
  weeklyFlow?: WeeklyFlowPoint[];
  monthlyFlow?: MonthlyFlowPoint[];
  meta?: Partial<SummaryMeta>;
}): SummaryResponse {
  const meta: SummaryMeta = {
    anchorDate: "2026-07-31",
    anchorBrut: 167.4,
    peak: { tarih: "2026-02-27", toplam: 210.3 },
    latestWeekly: "2026-07-31",
    latestDaily: "2026-08-03",
    updatedAt: "2026-08-04T05:30:00.000Z",
    unit: "milyar USD",
    source: "TCMB EVDS",
    swapMbSource: "fallback",
    swapMb: 16.4,
    goldPriceSource: "external:yahoo-gcf",
    cached: false,
    ...overrides?.meta,
  };
  return {
    weekly: [
      { tarih: "2026-07-24", toplam: 166.2, doviz: 82.2, altin: 84.0 },
      { tarih: "2026-07-31", toplam: 167.4, doviz: 82.7, altin: 84.7 },
    ],
    daily: [
      { tarih: "2026-07-31", brutRezerv: 167.4, nir: 47.9, goldPriceEffect: 0 },
      { tarih: "2026-08-03", brutRezerv: 168.9, nir: 48.2, goldPriceEffect: 0.9 },
    ],
    dolarizasyon: [],
    swap: [],
    foreignSecurities: [],
    weeklyFlow: overrides?.weeklyFlow ?? [
      { tarih: "2026-07-31", prevTarih: "2026-07-24", delta: 1.2, goldPriceEffect: 0.7, otherPart: 0.5 },
      { tarih: "2026-08-03", prevTarih: "2026-07-31", delta: 1.5, goldPriceEffect: 0.9, otherPart: 0.6, nowcast: true },
    ],
    monthlyFlow: overrides?.monthlyFlow ?? [
      { ay: "2026-07", tarih: "2026-07-31", prevTarih: "2026-06-26", delta: 4.3, goldPriceEffect: 2.1, otherPart: 2.2 },
      { ay: "2026-08", tarih: "2026-08-03", prevTarih: "2026-07-31", delta: 1.5, goldPriceEffect: 0.9, otherPart: 0.6, nowcast: true },
    ],
    meta,
  };
}

// --- buildReserveEmail (saf) -----------------------------------------------------

test("email: EN mutlu yol — konu, seviye, haftalık+aylık satırlar, caveat, kısa gövde", () => {
  const { subject, text } = buildReserveEmail(makeSummary(), { lang: "en", now: NOW });
  assert.equal(subject, "TCMB Gross Reserves — 04 Aug 2026");
  assert.ok(subject.length <= 60, "konu <= 60 karakter");
  assert.ok(
    text.includes("Level: 168.9 bn USD (nowcast, data through 03 Aug; last official 167.4 on 31 Jul)"),
    "seviye satırı",
  );
  assert.ok(
    text.includes("- Last completed week (24 Jul -> 31 Jul): +1.2 bn USD | gold valuation +0.7 | other +0.5"),
    "tamamlanan hafta satırı",
  );
  assert.ok(
    text.includes("- Week-to-date (31 Jul -> 03 Aug, 3 days, nowcast): +1.5 bn USD | gold valuation +0.9 | other +0.6"),
    "devam eden hafta (nowcast) satırı — aralık uzunluğu açık",
  );
  assert.ok(
    text.includes("- Last completed month (26 Jun -> 31 Jul): +4.3 bn USD | gold valuation +2.1 | other +2.2"),
    "tamamlanan ay satırı",
  );
  assert.ok(text.includes("- Month-to-date (31 Jul -> 03 Aug, 3 days, nowcast): +1.5 bn USD"), "devam eden ay satırı");
  assert.ok(!text.includes("Since last official week"), "taban güncelken uzun-dönem etiketi yok");
  assert.ok(!text.includes("Since last official month-end"), "ay-sonu resmiyken uzun-dönem etiketi yok");
  assert.ok(!text.includes("released Thu 14:30 TRT"), "gecikme yokken açıklama satırı eklenmez");
  assert.ok(text.includes("not pure intervention"), "caveat korunur");
  assert.ok(!text.includes("<"), "HTML işareti yok (düz metin)");
  assert.ok(text.split("\n").length <= 14, "EN blok kısa (<= 14 satır)");
});

test("email: gold-null (soft-fail) — yalnız delta + 'split unavailable', 'null' sızmaz", () => {
  const s = makeSummary({
    weeklyFlow: [
      { tarih: "2026-07-31", prevTarih: "2026-07-24", delta: -2.1, goldPriceEffect: null, otherPart: null },
      { tarih: "2026-08-03", prevTarih: "2026-07-31", delta: -0.4, goldPriceEffect: null, otherPart: null, nowcast: true },
    ],
    monthlyFlow: [
      { ay: "2026-07", tarih: "2026-07-31", prevTarih: "2026-06-26", delta: 4.3, goldPriceEffect: null, otherPart: null },
      { ay: "2026-08", tarih: "2026-08-03", prevTarih: "2026-07-31", delta: -0.4, goldPriceEffect: null, otherPart: null, nowcast: true },
    ],
    meta: { goldPriceSource: "unavailable" },
  });
  const { text } = buildReserveEmail(s, { lang: "en", now: NOW });
  assert.ok(
    text.includes("- Last completed week (24 Jul -> 31 Jul): -2.1 bn USD (gold/other split unavailable)"),
    "negatif delta + tek-mod satır",
  );
  assert.ok(!text.includes("null"), "'null' metne sızmaz");
  assert.ok(!text.includes("gold valuation"), "ayrıştırma parçaları yazılmaz");
});

test("email: stale (last-known-good) — konu [stale] + gövdede eski güncelleme uyarısı", () => {
  const s = makeSummary({ meta: { stale: true, updatedAt: "2026-08-01T12:30:00.000Z" } });
  const { subject, text } = buildReserveEmail(s, { lang: "en", now: NOW });
  assert.ok(subject.endsWith("[stale]"), "konu stale işaretli");
  assert.ok(subject.length <= 60, "stale konu da <= 60");
  assert.ok(text.includes("last successful update (01 Aug 2026)"), "gövde uyarısı updatedAt tarihiyle");
});

test("email: TR ve both — virgül ondalık, TR etiketler; both'ta EN üstte + ayraç", () => {
  const tr = buildReserveEmail(makeSummary(), { lang: "tr", now: NOW });
  assert.equal(tr.subject, "TCMB Brüt Rezervler — 04 Ağu 2026");
  assert.ok(tr.text.includes("Seviye: 168,9 mlr USD"), "TR seviye virgüllü");
  assert.ok(tr.text.includes("altın değerleme +0,7"), "TR altın etiketi + virgül");
  assert.ok(tr.text.includes("saf müdahale değildir"), "TR caveat");
  assert.ok(!tr.text.includes("bn USD"), "TR blokta EN birim yok");

  const both = buildReserveEmail(makeSummary(), { lang: "both", now: NOW });
  const enIdx = both.text.indexOf("Level: 168.9 bn USD");
  const trIdx = both.text.indexOf("Seviye: 168,9 mlr USD");
  assert.ok(enIdx >= 0 && trIdx >= 0, "iki blok da var");
  assert.ok(enIdx < trIdx, "EN blok üstte");
  assert.ok(both.text.includes("\n\n---\n\n"), "bloklar ayraçla ayrılır");
});

test("email: nowcast/veri yoksa 'n/a' — fırlatmaz", () => {
  const s = makeSummary({
    weeklyFlow: [
      { tarih: "2026-07-31", prevTarih: "2026-07-24", delta: 1.2, goldPriceEffect: 0.7, otherPart: 0.5 },
    ],
    monthlyFlow: [],
  });
  const { text } = buildReserveEmail(s, { lang: "en", now: NOW });
  assert.ok(text.includes("- Week-to-date: n/a"), "devam eden hafta yoksa n/a");
  assert.ok(text.includes("- Last completed month: n/a"), "aylık veri yoksa n/a");
  assert.ok(text.includes("- Month-to-date: n/a"), "devam eden ay yoksa n/a");
});

test("email: resmi Cuma baskısı gecikmeli — etiket+aralık dönemin GERÇEK uzunluğunu söyler", () => {
  // Gerçek vaka (06-08-2026 sabahı): TCMB haftalık baskısı Perşembe 14:30 TRT'de yayımlanır,
  // 31 Tem henüz yok → çıpa 24 Tem. Devam eden "hafta" 11 gün; aylık tabanı da Temmuz sonu değil.
  const s = makeSummary({
    weeklyFlow: [
      { tarih: "2026-07-24", prevTarih: "2026-07-17", delta: 2.1, goldPriceEffect: 1.3, otherPart: 0.8 },
      { tarih: "2026-08-04", prevTarih: "2026-07-24", delta: 4.9, goldPriceEffect: -0.8, otherPart: 5.7, nowcast: true },
    ],
    monthlyFlow: [
      { ay: "2026-06", tarih: "2026-06-26", prevTarih: "2026-05-29", delta: -1.1, goldPriceEffect: 0.4, otherPart: -1.5 },
      { ay: "2026-08", tarih: "2026-08-04", prevTarih: "2026-07-24", delta: 4.9, goldPriceEffect: -0.8, otherPart: 5.7, nowcast: true },
    ],
    meta: { anchorDate: "2026-07-24", anchorBrut: 162.6, latestWeekly: "2026-07-24", latestDaily: "2026-08-04" },
  });

  const en = buildReserveEmail(s, { lang: "en", now: new Date("2026-08-06T05:30:00Z") }).text;
  assert.ok(
    en.includes("- Since last official week (24 Jul -> 04 Aug, 11 days, nowcast): +4.9 bn USD"),
    "7 günü aşan devam eden dönem 'hafta' diye etiketlenmez",
  );
  assert.ok(!en.includes("- Week-to-date"), "yanıltıcı 'Week-to-date' etiketi kullanılmaz");
  assert.ok(
    en.includes("- Since last official month-end (24 Jul -> 04 Aug, 11 days, nowcast):"),
    "ay tabanı resmi ay-sonu değilse 'ay içi kümüle' denmez",
  );
  assert.ok(en.includes("the latest available is 24 Jul, so the ranges above span 11 days"), "gecikme açıklaması");

  const tr = buildReserveEmail(s, { lang: "tr", now: new Date("2026-08-06T05:30:00Z") }).text;
  assert.ok(tr.includes("- Son resmi haftadan bu yana (24 Tem -> 04 Ağu, 11 gün, nowcast):"), "TR uzun-dönem etiketi");
  assert.ok(
    tr.includes("- Son resmi ay sonundan bu yana (24 Tem -> 04 Ağu, 11 gün, nowcast):"),
    "TR ay uzun-dönem etiketi",
  );
  assert.ok(tr.includes("bir hafta değil 11 gün kapsar"), "TR gecikme açıklaması");

  // Hesaplama DEĞİŞMEDİ: delta ve ayrıştırma parçaları aynen aktarılır (yalnız etiket/aralık).
  assert.ok(en.includes("gold valuation -0.8 | other +5.7"), "ayrıştırma değerleri korunur");
});

test("email: devam eden ay barı iki ayı kapsıyorsa 'ay içi kümüle' denmez", () => {
  // Ayın ilk günlerinde o ayda henüz yayımlanmış Cuma yoktur → computeMonthlyFlow'un son ay
  // temsilcisi bir ay geride kalır ve devam eden bar iki ayı birden kapsar (canlı vaka:
  // 26 Haz -> 04 Ağu = 39 gün). Etiket bunu saklamamalı.
  const s = makeSummary({
    monthlyFlow: [
      { ay: "2026-06", tarih: "2026-06-26", prevTarih: "2026-05-29", delta: -1.1, goldPriceEffect: 0.4, otherPart: -1.5 },
      { ay: "2026-07", tarih: "2026-08-04", prevTarih: "2026-06-26", delta: 18.3, goldPriceEffect: -1.0, otherPart: 19.3, nowcast: true },
    ],
  });
  const { text } = buildReserveEmail(s, { lang: "en", now: new Date("2026-08-06T05:30:00Z") });
  assert.ok(
    text.includes("- Since last official month-end (26 Jun -> 04 Aug, 39 days, nowcast): +18.3 bn USD"),
    "39 günlük iki-aylı bar 'Month-to-date' diye etiketlenmez",
  );
  assert.ok(!text.includes("- Month-to-date"), "yanıltıcı 'Month-to-date' etiketi kullanılmaz");
});

// --- dispatch (worker.scheduled + mock sender) -----------------------------------

// EVDS yanıt mock'u (scheduled.test.ts ile aynı kabul değerleri).
const WEEKLY_ITEMS = [
  { Tarih: "27-02-2026", TP_AB_TOPLAM: "210300", TP_AB_C2: "73400", TP_AB_C1: "136800" },
  { Tarih: "12-06-2026", TP_AB_TOPLAM: "152080", TP_AB_C2: "80000", TP_AB_C1: "72080" },
];
const DAILY_ITEMS = [
  { Tarih: "12-06-2026", TP_AB_A02: "6400000000", TP_AB_A10: "4600000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "17-06-2026", TP_AB_A02: "6884800000", TP_AB_A10: "4650000000", TP_DK_USD_A_YTL: "40" },
  { Tarih: "19-06-2026", TP_AB_A02: "6600800000", TP_AB_A10: "4672800000", TP_DK_USD_A_YTL: "40" },
];
const DOLAR_ITEMS = [
  { Tarih: "12-06-2026", TP_HPBITABLO4_1: "262100", TP_HPBITABLO4_2: "222000" },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(): typeof fetch {
  return ((input: Request | string | URL) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("TP.AB.A02")) return Promise.resolve(jsonResponse({ items: DAILY_ITEMS }));
    if (url.includes("TP.HPBITABLO4.1")) return Promise.resolve(jsonResponse({ items: DOLAR_ITEMS }));
    return Promise.resolve(jsonResponse({ items: WEEKLY_ITEMS }));
  }) as typeof fetch;
}

const throwingFetch = (() => {
  throw new Error("EVDS'e gidilmemeli (test)");
}) as unknown as typeof fetch;

function makeSender(): { sender: EmailSender; calls: EmailSendMessage[] } {
  const calls: EmailSendMessage[] = [];
  const sender: EmailSender = {
    send: (m: EmailSendMessage) => {
      calls.push(m);
      return Promise.resolve({ messageId: "test-msg-id" });
    },
  };
  return { sender, calls };
}

function makeEnv(sender?: EmailSender): { env: Env; store: Map<string, string> } {
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
    DEFAULT_WEEKLY_START: START,
    EMAIL_SENDER: sender,
    EMAIL_TO: "tepe.erdinc@gmail.com",
    EMAIL_FROM: "rezerv@tqrlab.com",
    EMAIL_LANG: "both",
    EMAIL_CRON,
  };
  return { env, store };
}

function fakeController(cron: string): ScheduledController {
  return { cron, scheduledTime: 0, noRetry() {} } as unknown as ScheduledController;
}
function fakeCtx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

test("dispatch: sıcak cache'te EMAIL_CRON tetiği EVDS'e gitmeden TAM 1 mail gönderir", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = throwingFetch;
  try {
    const { sender, calls } = makeSender();
    const { env, store } = makeEnv(sender);
    store.set(summaryKey(START, todayDdMmYyyy()), JSON.stringify(makeSummary()));

    await worker.scheduled(fakeController(EMAIL_CRON), env, fakeCtx());

    assert.equal(calls.length, 1, "tam 1 mail");
    const msg = calls[0]!;
    assert.equal(msg.to, "tepe.erdinc@gmail.com");
    assert.ok(typeof msg.from === "object" && msg.from.email === "rezerv@tqrlab.com", "from doğru");
    assert.ok(msg.subject.startsWith("TCMB Gross Reserves"), "konu EN (both)");
    assert.ok(msg.text.includes("\n\n---\n\n"), "both: iki blok");
    assert.ok(!msg.text.includes("test-key-never-logged"), "secret maile sızmaz");
  } finally {
    globalThis.fetch = original;
  }
});

test("dispatch: cache miss'te build + gönderim + summary anahtarı ısıtılır", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const { sender, calls } = makeSender();
    const { env, store } = makeEnv(sender);

    await worker.scheduled(fakeController(EMAIL_CRON), env, fakeCtx());

    assert.equal(calls.length, 1, "mail gönderildi");
    assert.ok(store.has(summaryKey(START, todayDdMmYyyy())), "mail cron'u cache'i de ısıttı");
    // Mock'ta harici altın fiyatı yok → gold soft-fail → tek-mod satır beklenir.
    assert.ok(calls[0]!.text.includes("(gold/other split unavailable)"), "gold yokken tek-mod");
  } finally {
    globalThis.fetch = original;
  }
});

test("dispatch: build hatasında son-bilinen-iyi ile [stale] mail gönderilir", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = throwingFetch;
  try {
    const { sender, calls } = makeSender();
    const { env, store } = makeEnv(sender);
    store.set(summaryLastKey(START), JSON.stringify(makeSummary()));

    await worker.scheduled(fakeController(EMAIL_CRON), env, fakeCtx());

    assert.equal(calls.length, 1, "stale mail gönderildi");
    assert.ok(calls[0]!.subject.endsWith("[stale]"), "konu stale işaretli");
  } finally {
    globalThis.fetch = original;
  }
});

test("dispatch: hiç veri yoksa mail atlanır ve cron fırlatmaz", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = throwingFetch;
  try {
    const { sender, calls } = makeSender();
    const { env } = makeEnv(sender);

    await worker.scheduled(fakeController(EMAIL_CRON), env, fakeCtx());

    assert.equal(calls.length, 0, "veri yokken mail yok");
  } finally {
    globalThis.fetch = original;
  }
});

test("dispatch: çoklu alıcı — her adrese ayrı mail; biri reddedilse diğeri teslim edilir", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = throwingFetch;
  try {
    const calls: EmailSendMessage[] = [];
    const sender: EmailSender = {
      send: (m: EmailSendMessage) => {
        calls.push(m);
        if (m.to === "erdinc.tepe@bgcg.com") {
          return Promise.reject(new Error("E_RECIPIENT_NOT_ALLOWED"));
        }
        return Promise.resolve({ messageId: `id-${calls.length}` });
      },
    };
    const { env, store } = makeEnv(sender);
    env.EMAIL_TO = "tepe.erdinc@gmail.com, erdinc.tepe@bgcg.com"; // boşluk: trim testi
    store.set(summaryKey(START, todayDdMmYyyy()), JSON.stringify(makeSummary()));

    await worker.scheduled(fakeController(EMAIL_CRON), env, fakeCtx());

    assert.equal(calls.length, 2, "iki alıcıya iki ayrı send");
    assert.deepEqual(
      calls.map((m) => m.to).sort(),
      ["erdinc.tepe@bgcg.com", "tepe.erdinc@gmail.com"],
      "alıcılar doğru (trim edilmiş)",
    );
    // bgcg reddedildi ama cron fırlatmadı ve gmail gönderimi tamamlandı (allSettled).
  } finally {
    globalThis.fetch = original;
  }
});

test("dispatch: binding yoksa EMAIL_CRON tetiği sessizce atlar (fırlatmaz)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = throwingFetch;
  try {
    const { env } = makeEnv(undefined);
    await worker.scheduled(fakeController(EMAIL_CRON), env, fakeCtx());
  } finally {
    globalThis.fetch = original;
  }
});
