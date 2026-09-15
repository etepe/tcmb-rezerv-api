// M-002 offline birim testi (ağ/secret gerektirmez).
// computeWeekly /1000 dönüşümü, ISO tarih, sıralama, peak/latest mantığını doğrular.
// Çalıştır: node --test --experimental-strip-types
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDailyNowcast,
  computeDolarizasyon,
  computeForeignSecurities,
  computeFxFlow,
  computeGoldPriceEffect,
  computeMonthlyFlow,
  computeSwapSplit,
  computeWeekly,
  computeWeeklyFlow,
  EngineError,
  weeklyMeta,
} from "../src/reserve-engine.ts";
import type { RawRow, SwapPoint, WeeklyPoint } from "../src/types.ts";

// Kabul testi referans değerleri (CLAUDE.md): ham milyon USD.
const rows: RawRow[] = [
  // Baz 27-02-2026: toplam 210.3 / altın 136.8 / döviz 73.4 (milyar)
  { tarih: "27-02-2026", TP_AB_TOPLAM: 210300, TP_AB_C2: 73400, TP_AB_C1: 136800 },
  // Çıpa 12-06-2026: toplam 152.08 (milyar)
  { tarih: "12-06-2026", TP_AB_TOPLAM: 152081.1, TP_AB_C2: 80000, TP_AB_C1: 72081.1 },
  // toplam null -> atılır
  { tarih: "19-06-2026", TP_AB_TOPLAM: null, TP_AB_C2: 1, TP_AB_C1: 1 },
];

test("computeWeekly: /1000, ISO tarih, sıralama", () => {
  const weekly = computeWeekly(rows);
  assert.equal(weekly.length, 2, "toplam=null satırı atılmalı");
  // Artan sıra
  assert.equal(weekly[0]?.tarih, "2026-02-27");
  assert.equal(weekly[1]?.tarih, "2026-06-12");
  // Baz değerleri (kabul testi)
  assert.equal(weekly[0]?.toplam, 210.3);
  assert.equal(weekly[0]?.altin, 136.8);
  assert.equal(weekly[0]?.doviz, 73.4);
  // Çıpa toplam ~152.08
  assert.ok(Math.abs((weekly[1]?.toplam ?? 0) - 152.0811) < 1e-6);
});

test("weeklyMeta: peak en yüksek toplam, latest son tarih", () => {
  const weekly = computeWeekly(rows);
  const meta = weeklyMeta(weekly);
  assert.equal(meta.peak.tarih, "2026-02-27");
  assert.equal(meta.peak.toplam, 210.3);
  assert.equal(meta.latest.tarih, "2026-06-12");
  assert.equal(meta.count, 2);
});

test("computeWeekly: boş seri -> empty_series", () => {
  assert.throws(
    () => computeWeekly([{ tarih: "01-01-2026", TP_AB_TOPLAM: null }]),
    (e: unknown) => e instanceof EngineError && e.code === "empty_series",
  );
});

// --- Faz 2: computeDailyNowcast (nowcast + NIR) -----------------------------
// Kabul testi (CLAUDE.md / DoD): çıpa 12-06 = 152.08 (resmi haftalık).
//   nowcast 17/18/19-06 = 164.2 / 159.4 / 157.1 (±0,1).  NIR 19-06 ≈ 48.2.
// Girdiler USD=40 sabit alınarak hedef çıktıları birebir verecek şekilde kurulur
// (A02 bin TL, A10 bin TL): disVarlikUsd = A02/USD/1e6, brut = çıpa + (dv − dv_çıpa).
const weeklyFixture: WeeklyPoint[] = [
  { tarih: "2026-02-27", toplam: 210.3, doviz: 73.4, altin: 136.8 },
  { tarih: "2026-06-12", toplam: 152.08, doviz: 80.0, altin: 72.08 }, // çıpa
];
// USD=40 -> A02 = disVarlikUsd * 4e7.  dv: 12→160, 17→172.12, 18→167.32, 19→165.02.
const dailyFixture: RawRow[] = [
  { tarih: "12-06-2026", TP_AB_A02: 6_400_000_000, TP_AB_A10: 4_600_000_000, TP_DK_USD_A_YTL: 40 },
  { tarih: "17-06-2026", TP_AB_A02: 6_884_800_000, TP_AB_A10: 4_650_000_000, TP_DK_USD_A_YTL: 40 },
  { tarih: "18-06-2026", TP_AB_A02: 6_692_800_000, TP_AB_A10: 4_660_000_000, TP_DK_USD_A_YTL: 40 },
  // A10_19 = 116.82 * 4e7 -> NIR_19 = 165.02 − 116.82 = 48.2
  { tarih: "19-06-2026", TP_AB_A02: 6_600_800_000, TP_AB_A10: 4_672_800_000, TP_DK_USD_A_YTL: 40 },
];

test("computeDailyNowcast: kabul (17/18/19-06 = 164.2/159.4/157.1, NIR_19≈48.2)", () => {
  const daily = computeDailyNowcast(weeklyFixture, dailyFixture);
  assert.equal(daily.length, 4);
  // Artan sıra + çıpa günü ilk nokta.
  assert.equal(daily[0]?.tarih, "2026-06-12");
  // Çıpa gününde nowcast = çıpa toplam (fark 0).
  assert.ok(Math.abs((daily[0]?.brutRezerv ?? 0) - 152.08) < 0.1, "çıpa günü = 152.08");
  const byDate = new Map(daily.map((d) => [d.tarih, d]));
  assert.ok(Math.abs((byDate.get("2026-06-17")?.brutRezerv ?? 0) - 164.2) < 0.1, "17-06 = 164.2");
  assert.ok(Math.abs((byDate.get("2026-06-18")?.brutRezerv ?? 0) - 159.4) < 0.1, "18-06 = 159.4");
  assert.ok(Math.abs((byDate.get("2026-06-19")?.brutRezerv ?? 0) - 157.1) < 0.1, "19-06 = 157.1");
  // NIR her günlük noktada var; 19-06 ≈ 48.2.
  assert.ok(daily.every((d) => d.nir !== null), "NIR her noktada dolu");
  assert.ok(Math.abs((byDate.get("2026-06-19")?.nir ?? 0) - 48.2) < 0.1, "NIR_19 ≈ 48.2");
});

test("computeDailyNowcast: A10 null VEYA 0 ise NIR null (Python `if a10`), nokta tutulur", () => {
  for (const a10 of [null, 0]) {
    const rows: RawRow[] = [
      { tarih: "12-06-2026", TP_AB_A02: 6_400_000_000, TP_AB_A10: a10, TP_DK_USD_A_YTL: 40 },
    ];
    const daily = computeDailyNowcast(weeklyFixture, rows);
    assert.equal(daily.length, 1);
    assert.equal(daily[0]?.nir, null, `A10=${a10} -> NIR null`);
    assert.ok(Math.abs((daily[0]?.brutRezerv ?? 0) - 152.08) < 0.1);
  }
});

test("computeDailyNowcast: haftalık boş -> no_anchor", () => {
  assert.throws(
    () => computeDailyNowcast([], dailyFixture),
    (e: unknown) => e instanceof EngineError && e.code === "no_anchor",
  );
});

test("computeDailyNowcast: çıpa günlükte yok -> anchor_not_in_daily", () => {
  const rows: RawRow[] = [
    { tarih: "17-06-2026", TP_AB_A02: 6_884_800_000, TP_AB_A10: 4_650_000_000, TP_DK_USD_A_YTL: 40 },
  ];
  assert.throws(
    () => computeDailyNowcast(weeklyFixture, rows),
    (e: unknown) => e instanceof EngineError && e.code === "anchor_not_in_daily",
  );
});

// --- Faz 3: computeDolarizasyon (haftalık YP mevduat) -----------------------
// Kabul (DoD): 12-06-2026 -> ypToplam ≈ 262.1, ypYurtici ≈ 222.0 (ham milyon /1000).
const dolarRows: RawRow[] = [
  { tarih: "27-02-2026", TP_HPBITABLO4_1: 250000, TP_HPBITABLO4_2: 210000 },
  // Sırasız girilir; computeDolarizasyon artan sıralamalı dönmeli.
  { tarih: "12-06-2026", TP_HPBITABLO4_1: 262100, TP_HPBITABLO4_2: 222000 },
];

test("computeDolarizasyon: /1000, ISO tarih, sıralama, kabul (262.1/222.0)", () => {
  const dolar = computeDolarizasyon(dolarRows);
  assert.equal(dolar.length, 2);
  // Artan sıra.
  assert.equal(dolar[0]?.tarih, "2026-02-27");
  assert.equal(dolar[1]?.tarih, "2026-06-12");
  // /1000 dönüşümü (milyon -> milyar).
  assert.equal(dolar[0]?.ypToplam, 250);
  assert.equal(dolar[0]?.ypYurtici, 210);
  // Kabul: 12-06 -> 262.1 / 222.0.
  assert.ok(Math.abs((dolar[1]?.ypToplam ?? 0) - 262.1) < 1e-6, "ypToplam 262.1");
  assert.ok(Math.abs((dolar[1]?.ypYurtici ?? 0) - 222.0) < 1e-6, "ypYurtici 222.0");
});

test("computeDolarizasyon: ypYurtici null -> 0; ypToplam null satır atılır", () => {
  const dolar = computeDolarizasyon([
    { tarih: "12-06-2026", TP_HPBITABLO4_1: 262100, TP_HPBITABLO4_2: null },
    { tarih: "19-06-2026", TP_HPBITABLO4_1: null, TP_HPBITABLO4_2: 1 }, // toplam null -> atılır
  ]);
  assert.equal(dolar.length, 1);
  assert.equal(dolar[0]?.ypYurtici, 0);
});

test("computeDolarizasyon: boş seri -> empty_series", () => {
  assert.throws(
    () => computeDolarizasyon([{ tarih: "01-01-2026", TP_HPBITABLO4_1: null }]),
    (e: unknown) => e instanceof EngineError && e.code === "empty_series",
  );
});

// --- Faz 5: computeSwapSplit (swap ayrıştırması + net dış varlık swap hariç) -----
// USD=40. netDahil=(A02−A11−A14)/USD/1e6. 06-04 hedef netDahil=50 -> A02−A11−A14=2e9.
// yerli=(13517−1803)/1000=11.714 ; ymb=|−16310|/1000=16.31 ; toplam=28.024 ; netHaric=21.976.
const swapDaily: RawRow[] = [
  {
    tarih: "06-04-2026",
    TP_AB_A02: 6_400_000_000,
    TP_AB_A11: 400_000_000,
    TP_AB_A14: 4_000_000_000,
    TP_AB_A10: 4_000_000_000,
    TP_DK_USD_A_YTL: 40,
  },
];
const swapStok: RawRow[] = [
  { tarih: "06-04-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: 13517, TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: 1803 },
];
const mbStok: RawRow[] = [
  { tarih: "2026-3", TP_DOVVARNC_K18: -16130 }, // Mart -> 16.13
  { tarih: "2026-4", TP_DOVVARNC_K18: -16310 }, // Nisan -> 16.31
];

test("computeSwapSplit: kabul (netDahil/yerli/ymb/toplam/netHaric)", () => {
  const r = computeSwapSplit(swapDaily, swapStok, mbStok, 16.4);
  assert.equal(r.mbSource, "evds:K18");
  assert.equal(r.points.length, 1);
  const p = r.points[0]!;
  assert.equal(p.tarih, "2026-04-06");
  assert.ok(Math.abs(p.netDahil - 50) < 1e-6, "netDahil 50");
  assert.ok(Math.abs(p.yerliBanka - 11.714) < 1e-6, "yerli 11.714");
  assert.ok(Math.abs(p.yabanciMb - 16.31) < 1e-9, "ymb 16.31 (Nisan K18)");
  assert.ok(Math.abs(p.toplamSwap - 28.024) < 1e-6, "toplam 28.024");
  assert.ok(Math.abs(p.netHaric - 21.976) < 1e-6, "netHaric 21.976");
  assert.ok(Math.abs(r.mb - 16.31) < 1e-9, "meta mb = son nokta ymb");
  // Faz 11 — kamu (A13) = (A10 − A11 − A14)/USD/1e6 = (4e9 − 4e8 − 4e9)/4e7 = −10 (fixture; işaret korunur).
  assert.ok(Math.abs((p.kamu ?? 0) - -10) < 1e-6, "kamu −10");
  const noA10 = computeSwapSplit(
    [{ ...swapDaily[0]!, TP_AB_A10: null }],
    swapStok,
    mbStok,
    16.4,
  );
  assert.equal(noA10.points[0]?.kamu, null, "A10 yoksa kamu null (uydurma 0 yok)");
});

test("computeSwapSplit: ay-adımı — her gün kendi ayının K18'ini alır", () => {
  const daily: RawRow[] = [
    { tarih: "31-03-2026", TP_AB_A02: 4_000_000_000, TP_AB_A11: 0, TP_AB_A14: 0, TP_DK_USD_A_YTL: 40 },
    { tarih: "06-04-2026", TP_AB_A02: 4_000_000_000, TP_AB_A11: 0, TP_AB_A14: 0, TP_DK_USD_A_YTL: 40 },
  ];
  const stok: RawRow[] = [
    { tarih: "31-03-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: 0, TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: 0 },
    { tarih: "06-04-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: 0, TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: 0 },
  ];
  const r = computeSwapSplit(daily, stok, mbStok, 16.4);
  const byDate = new Map(r.points.map((p) => [p.tarih, p]));
  assert.ok(Math.abs((byDate.get("2026-03-31")?.yabanciMb ?? 0) - 16.13) < 1e-9, "Mart -> 16.13");
  assert.ok(Math.abs((byDate.get("2026-04-06")?.yabanciMb ?? 0) - 16.31) < 1e-9, "Nisan -> 16.31");
});

test("computeSwapSplit: K18 yoksa fallback sabiti + mbSource=fallback", () => {
  const r = computeSwapSplit(swapDaily, swapStok, [], 16.4);
  assert.equal(r.mbSource, "fallback");
  assert.equal(r.points[0]?.yabanciMb, 16.4);
  assert.ok(Math.abs((r.points[0]?.toplamSwap ?? 0) - (16.4 + 11.714)) < 1e-6);
});

test("computeSwapSplit: swap satırı olmayan / A02 olmayan gün atlanır", () => {
  const daily: RawRow[] = [
    // swap satırı yok -> atlanır
    { tarih: "06-04-2026", TP_AB_A02: 6_400_000_000, TP_AB_A11: 0, TP_AB_A14: 0, TP_DK_USD_A_YTL: 40 },
    // A02 yok -> atlanır
    { tarih: "07-04-2026", TP_AB_A02: null, TP_DK_USD_A_YTL: 40 },
  ];
  const stok: RawRow[] = [
    { tarih: "07-04-2026", TP_SWAPTEKTAR_TOTALSTOKALIMYONLU: 100, TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU: 0 },
  ];
  const r = computeSwapSplit(daily, stok, mbStok, 16.4);
  assert.equal(r.points.length, 0, "iki gün de atlanmalı");
});

// --- Faz 6: computeGoldPriceEffect (altın-fiyat değerleme etkisi) -----------------
// anchorAltin = weeklyFixture son nokta altin = 72.08 (C1, mlr USD).
// etki_kum(t) = 72.08 × (fiyat(t)/fiyat(çıpa) − 1). Çıpa 12-06 fiyat 4000.
test("computeGoldPriceEffect: oran-bazlı kümülatif etki + çıpada 0", () => {
  const daily = computeDailyNowcast(weeklyFixture, dailyFixture); // 12/17/18/19
  const gold = new Map<string, number>([
    ["2026-06-12", 4000],
    ["2026-06-17", 4200],
    ["2026-06-18", 4100],
    ["2026-06-19", 4040],
  ]);
  const out = computeGoldPriceEffect(weeklyFixture, daily, gold);
  const by = new Map(out.map((d) => [d.tarih, d]));
  assert.ok(Math.abs((by.get("2026-06-12")!.goldPriceEffect ?? -1) - 0) < 1e-9, "çıpada etki 0");
  assert.ok(Math.abs((by.get("2026-06-17")!.goldPriceEffect ?? 0) - 72.08 * 0.05) < 1e-9, "17-06 = 3.604");
  assert.ok(Math.abs((by.get("2026-06-19")!.goldPriceEffect ?? 0) - 72.08 * 0.01) < 1e-9, "19-06 = 0.7208");
  // brutRezerv/nir korunur (saf birleştirme).
  assert.ok(Math.abs((by.get("2026-06-19")!.brutRezerv ?? 0) - 157.1) < 0.1, "brutRezerv korunur");
});

test("computeGoldPriceEffect: eksik gün en yakın önceki fiyatı alır", () => {
  const daily = computeDailyNowcast(weeklyFixture, dailyFixture);
  const gold = new Map<string, number>([
    ["2026-06-12", 4000],
    ["2026-06-16", 4200], // 17/18/19 yok -> en yakın önceki (4200) kullanılır
  ]);
  const out = computeGoldPriceEffect(weeklyFixture, daily, gold);
  const by = new Map(out.map((d) => [d.tarih, d]));
  const e = 72.08 * (4200 / 4000 - 1);
  assert.ok(Math.abs((by.get("2026-06-19")!.goldPriceEffect ?? 0) - e) < 1e-9, "17/18/19 = 4200 etkisi");
});

test("computeGoldPriceEffect: boş harita / çıpa fiyatı yok -> tümü null (soft-fail)", () => {
  const daily = computeDailyNowcast(weeklyFixture, dailyFixture);
  assert.ok(computeGoldPriceEffect(weeklyFixture, daily, new Map()).every((d) => d.goldPriceEffect === null), "boş harita");
  // Çıpa (12-06) ve öncesi fiyat yoksa oran kurulamaz -> null.
  const noAnchor = new Map<string, number>([["2026-06-17", 4200]]);
  assert.ok(computeGoldPriceEffect(weeklyFixture, daily, noAnchor).every((d) => d.goldPriceEffect === null), "çıpa fiyatı yok");
});

// --- Faz 8: computeWeeklyFlow (haftalık rezerv değişimi: altın fiyat etkisi vs diğer) ---
// weeklyFixture: 27-02 (altin 136.8) → 12-06 (çıpa, altin 72.08). 1 tarihsel bar + 1 nowcast.
test("computeWeeklyFlow: tarihsel Cuma-Cuma ayrıştırma + nowcast son sütun", () => {
  const gold = new Map<string, number>([
    ["2026-02-27", 3000],
    ["2026-06-12", 4000],
    ["2026-06-19", 4040],
  ]);
  const daily = computeGoldPriceEffect(
    weeklyFixture,
    computeDailyNowcast(weeklyFixture, dailyFixture),
    gold,
  );
  const flow = computeWeeklyFlow(weeklyFixture, daily, gold);
  assert.equal(flow.length, 2, "1 tarihsel + 1 nowcast");

  // Tarihsel: 27-02 → 12-06. delta = 152.08 − 210.3 = −58.22.
  //   gold = 136.8 × (4000/3000 − 1) = 45.6 ; other = −58.22 − 45.6 = −103.82.
  const h = flow[0]!;
  assert.equal(h.tarih, "2026-06-12");
  assert.equal(h.prevTarih, "2026-02-27");
  assert.ok(!h.nowcast, "tarihsel bar nowcast değil");
  assert.ok(Math.abs(h.delta - (152.08 - 210.3)) < 1e-9, "delta = −58.22");
  assert.ok(Math.abs((h.goldPriceEffect ?? 0) - 45.6) < 1e-9, "gold = 45.6");
  assert.ok(Math.abs((h.otherPart ?? 0) - (152.08 - 210.3 - 45.6)) < 1e-9, "other = delta − gold");

  // Nowcast: çıpa 12-06 → son günlük 19-06. delta = brut_19 − 152.08 ≈ 5.02.
  //   gold = daily[19-06].goldPriceEffect = 72.08 × (4040/4000 − 1) = 0.7208.
  const n = flow[1]!;
  assert.equal(n.tarih, "2026-06-19");
  assert.equal(n.prevTarih, "2026-06-12");
  assert.equal(n.nowcast, true, "son sütun nowcast");
  assert.ok(Math.abs(n.delta - (157.1 - 152.08)) < 0.02, "delta ≈ 5.02");
  assert.ok(Math.abs((n.goldPriceEffect ?? 0) - 72.08 * 0.01) < 1e-9, "gold = 0.7208");
  assert.ok(Math.abs((n.otherPart ?? 0) - (n.delta - 72.08 * 0.01)) < 1e-9, "other = delta − gold");
});

test("computeWeeklyFlow: altın yok (boş harita) -> gold/other null, delta dolu", () => {
  const daily = computeDailyNowcast(weeklyFixture, dailyFixture); // goldPriceEffect null
  const flow = computeWeeklyFlow(weeklyFixture, daily, new Map());
  assert.equal(flow.length, 2);
  for (const p of flow) {
    assert.equal(p.goldPriceEffect, null, "gold null");
    assert.equal(p.otherPart, null, "other null");
    assert.equal(typeof p.delta, "number", "delta yine dolu");
  }
  assert.ok(Math.abs(flow[0]!.delta - (152.08 - 210.3)) < 1e-9, "tarihsel delta korunur");
});

// --- Faz 9: computeMonthlyFlow (aylık rezerv değişimi: weeklyFlow'un aylık analoğu) ---
// Fixture: Nisan iki Cuma (10 & 24 → temsilci son Cuma 24), Mayıs 29, Haziran 12 (anchor).
// Günlük nowcast Haziran içinde (12 anchor → 19). Beklenen: 1 tarihsel (Mayıs) + 1 nowcast (Haziran).
const monthlyWeeklyFixture: WeeklyPoint[] = [
  { tarih: "2026-04-10", toplam: 98, doviz: 59, altin: 39 },
  { tarih: "2026-04-24", toplam: 100, doviz: 60, altin: 40 }, // Nisan temsilci (son Cuma)
  { tarih: "2026-05-29", toplam: 110, doviz: 66, altin: 44 }, // Mayıs temsilci
  { tarih: "2026-06-12", toplam: 120, doviz: 70, altin: 50 }, // Haziran temsilci = anchor
];
// USD=40. disVarlikUsd = A02/40/1e6. brut(t)=anchor.toplam + (dv(t)−dv(anchor)).
// dv(12)=300, dv(19)=305 → brut_19 = 120 + 5 = 125.
const monthlyDailyRows: RawRow[] = [
  { tarih: "12-06-2026", TP_AB_A02: 12_000_000_000, TP_AB_A10: 4_000_000_000, TP_DK_USD_A_YTL: 40 },
  { tarih: "19-06-2026", TP_AB_A02: 12_200_000_000, TP_AB_A10: 4_000_000_000, TP_DK_USD_A_YTL: 40 },
];

test("computeMonthlyFlow: ay-sonu Cuma gruplama + tarihsel bar + nowcast son ay", () => {
  const daily = computeDailyNowcast(monthlyWeeklyFixture, monthlyDailyRows);
  const gold = new Map<string, number>([
    ["2026-04-24", 3000],
    ["2026-05-29", 4000],
    ["2026-06-12", 4000],
    ["2026-06-19", 4400],
  ]);
  const flow = computeMonthlyFlow(monthlyWeeklyFixture, daily, gold);
  assert.equal(flow.length, 2, "1 tarihsel (Mayıs) + 1 nowcast (Haziran)");

  // Tarihsel Mayıs: Nisan temsilci (24, son Cuma) → Mayıs (29). delta = 110 − 100 = 10.
  //   gold = 40 × (4000/3000 − 1) = 13.333 ; other = 10 − gold.
  const h = flow[0]!;
  assert.equal(h.ay, "2026-05");
  assert.equal(h.tarih, "2026-05-29");
  assert.equal(h.prevTarih, "2026-04-24", "Nisan temsilcisi son Cuma (24), erken Cuma (10) değil");
  assert.ok(!h.nowcast, "tarihsel bar nowcast değil");
  assert.ok(Math.abs(h.delta - 10) < 1e-9, "delta = 10");
  assert.ok(Math.abs((h.goldPriceEffect ?? 0) - 40 * (4000 / 3000 - 1)) < 1e-9, "gold = 13.333");
  assert.ok(Math.abs((h.otherPart ?? 0) - (10 - 40 * (4000 / 3000 - 1))) < 1e-9, "other = delta − gold");

  // Nowcast Haziran: Mayıs-sonu (29, toplam 110) → güncel günlük (19-06, brut 125). delta = 15.
  //   gold = altin_Mayıs(44) × (fiyat_19/fiyat_29 − 1) = 44 × (4400/4000 − 1) = 4.4 ; other = 15 − 4.4.
  const n = flow[1]!;
  assert.equal(n.ay, "2026-06");
  assert.equal(n.tarih, "2026-06-19");
  assert.equal(n.prevTarih, "2026-05-29", "nowcast tabanı önceki ay-sonu (Mayıs 29)");
  assert.equal(n.nowcast, true, "son sütun nowcast");
  assert.ok(Math.abs(n.delta - 15) < 1e-9, "delta = 15 (125 − 110)");
  assert.ok(Math.abs((n.goldPriceEffect ?? 0) - 44 * (4400 / 4000 - 1)) < 1e-9, "gold = 4.4");
  assert.ok(Math.abs((n.otherPart ?? 0) - (15 - 4.4)) < 1e-9, "other = delta − gold = 10.6");
});

test("computeMonthlyFlow: altın yok (boş harita) -> gold/other null, delta dolu", () => {
  const daily = computeDailyNowcast(monthlyWeeklyFixture, monthlyDailyRows);
  const flow = computeMonthlyFlow(monthlyWeeklyFixture, daily, new Map());
  assert.equal(flow.length, 2);
  for (const p of flow) {
    assert.equal(p.goldPriceEffect, null, "gold null");
    assert.equal(p.otherPart, null, "other null");
    assert.equal(typeof p.delta, "number", "delta yine dolu");
  }
  assert.ok(Math.abs(flow[0]!.delta - 10) < 1e-9, "tarihsel Mayıs delta korunur");
});

test("computeMonthlyFlow: < 2 ay veri -> boş dizi", () => {
  const oneMonth: WeeklyPoint[] = [{ tarih: "2026-06-12", toplam: 120, doviz: 70, altin: 50 }];
  const daily = computeDailyNowcast(oneMonth, monthlyDailyRows);
  assert.equal(computeMonthlyFlow(oneMonth, daily, new Map()).length, 0);
});

// --- Faz 7: computeForeignSecurities (yurt dışı yerleşik menkul kıymet) -----------
// Ham milyon USD → /1000 (milyar). Anahtarlar (bie_mknethar): hisse M1/M7 · DİBS M2/M8 ·
// ÖST M6/M12 · eurobond (Yurt Dışı Piyasa) M15/M22.
const fsRows: RawRow[] = [
  {
    tarih: "05-06-2026",
    TP_MKNETHAR_M7: 293.1, // hisse net
    TP_MKNETHAR_M1: 24000, // hisse stok
    TP_MKNETHAR_M8: -334.8, // DİBS net
    TP_MKNETHAR_M2: 11000, // DİBS stok
    TP_MKNETHAR_M12: 36.5, // ÖST net
    TP_MKNETHAR_M6: 900, // ÖST stok
    TP_MKNETHAR_M22: -120.4, // eurobond net
    TP_MKNETHAR_M15: 7000, // eurobond stok
  },
  // Sırasız girilir; artan sıralı dönmeli.
  {
    tarih: "29-05-2026",
    TP_MKNETHAR_M7: 100,
    TP_MKNETHAR_M1: 23800,
    TP_MKNETHAR_M8: 50,
    TP_MKNETHAR_M2: 11300,
    TP_MKNETHAR_M12: 10,
    TP_MKNETHAR_M6: 880,
    TP_MKNETHAR_M22: 30,
    TP_MKNETHAR_M15: 6950,
  },
];

test("computeForeignSecurities: /1000, ISO tarih, sıralama, işaret korunur", () => {
  const fs = computeForeignSecurities(fsRows);
  assert.equal(fs.length, 2);
  // Artan sıra.
  assert.equal(fs[0]?.tarih, "2026-05-29");
  assert.equal(fs[1]?.tarih, "2026-06-05");
  // /1000 dönüşümü + net akım işareti (DİBS satışı negatif).
  assert.ok(Math.abs((fs[1]?.hisseFlow ?? 0) - 0.2931) < 1e-9, "hisse net 0.2931");
  assert.ok(Math.abs((fs[1]?.dibsFlow ?? 0) - -0.3348) < 1e-9, "DİBS net −0.3348");
  assert.ok(Math.abs((fs[1]?.ostFlow ?? 0) - 0.0365) < 1e-9, "ÖST net 0.0365");
  assert.ok(Math.abs((fs[1]?.eurobondFlow ?? 0) - -0.1204) < 1e-9, "eurobond net −0.1204");
  assert.equal(fs[1]?.hisseStock, 24);
  assert.equal(fs[1]?.dibsStock, 11);
  assert.equal(fs[1]?.ostStock, 0.9);
  assert.equal(fs[1]?.eurobondStock, 7);
});

test("computeForeignSecurities: eksik alan -> 0; altısı da null olan satır atlanır", () => {
  const fs = computeForeignSecurities([
    // yalnız hisse stok dolu; diğerleri 0'a normalize.
    { tarih: "12-06-2026", TP_MKNETHAR_M1: 24500 },
    // altısı da null -> atlanır.
    { tarih: "19-06-2026", TP_MKNETHAR_M7: null, TP_MKNETHAR_M2: null },
  ]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0]?.hisseStock, 24.5);
  assert.equal(fs[0]?.dibsFlow, 0);
  assert.equal(fs[0]?.ostStock, 0);
});

test("computeForeignSecurities: boş seri -> empty_series", () => {
  assert.throws(
    () => computeForeignSecurities([{ tarih: "01-01-2026", TP_MKNETHAR_M7: null }]),
    (e: unknown) => e instanceof EngineError && e.code === "empty_series",
  );
});

// --- Faz 11: computeFxFlow (günlük net döviz alımı / satımı) -------------------------
// Doğrulanmış tanım: fxFlow = ΔnetHaric − Γ − ΔKamu − swapRev ≡ ΔnetDahil − ΔyerliBanka − Γ − ΔKamu.
// Γ = altin(F) × (fiyat_n − fiyat_{n-1}) / fiyat(F); F = prev'e en yakın önceki resmi Cuma.
const fxWeekly: WeeklyPoint[] = [
  { tarih: "2026-08-28", toplam: 188.2, doviz: 71.1, altin: 117.1 },
  { tarih: "2026-09-04", toplam: 184.25, doviz: 70.4, altin: 113.84 }, // çıpa; fiyat 4453 → Q≈25.56M ons
];
const sp = (tarih: string, netDahil: number, yerliBanka: number, yabanciMb: number, kamu: number | null): SwapPoint => ({
  tarih,
  netDahil,
  yabanciMb,
  yerliBanka,
  toplamSwap: yabanciMb + yerliBanka,
  netHaric: netDahil - yabanciMb - yerliBanka,
  kamu,
});
// Canlı 10→11.09.2026 (referans analist serisi −0.81): ΔnetDahil −1.964, Δyerli +0.132, Γ ≈ −1.253, ΔKamu −0.04.
const fxSwap: SwapPoint[] = [
  sp("2026-09-04", 67.797, -4.338, 16.339, 5.962),
  sp("2026-09-10", 66.111, -4.402, 16.339, 5.722),
  sp("2026-09-11", 64.147, -4.270, 16.339, 5.682),
];
const fxGold = new Map<string, number>([
  ["2026-09-04", 4453],
  ["2026-09-10", 4388],
  ["2026-09-11", 4339],
]);

test("computeFxFlow: kabul — 10→11.09 ≈ −0.81 (referans analist serisi) + kimlik kapanır", () => {
  const out = computeFxFlow(fxSwap, fxWeekly, fxGold);
  assert.equal(out.length, 2, "n−1 nokta");
  const p = out[1]!;
  assert.equal(p.tarih, "2026-09-11");
  assert.equal(p.prevTarih, "2026-09-10");
  assert.ok(Math.abs(p.deltaNetHaric - (-1.964 - 0.132)) < 1e-6, "ΔnetHaric = ΔnetDahil − Δyerli (ymb sabit)");
  const gamma = 113.84 * (4339 - 4388) / 4453;
  assert.ok(Math.abs((p.goldPriceEffect ?? 0) - gamma) < 1e-9, "Γ Laspeyres (ima edilen ons, çıpa 04-09)");
  assert.ok(Math.abs((p.kamuDelta ?? 0) - -0.04) < 1e-9, "ΔKamu −0.04");
  assert.equal(p.swapRevision, 0, "ay içinde swap revizyonu 0");
  assert.ok(Math.abs((p.fxFlow ?? 0) - -0.81) < 0.02, "net döviz alımı ≈ −0.81 (satış)");
  // Kimlik: ΔnetHaric = fx + Γ + ΔKamu + swapRev
  for (const q of out) {
    assert.ok(
      Math.abs(q.deltaNetHaric - ((q.fxFlow ?? 0) + (q.goldPriceEffect ?? 0) + (q.kamuDelta ?? 0) + q.swapRevision)) < 1e-9,
      "kimlik kapanır",
    );
  }
});

test("computeFxFlow: Yabancı MB ay adımı swapRevision'a gider (işlem sayılmaz)", () => {
  const swap: SwapPoint[] = [
    sp("2026-08-31", 60, 0, 16.0, 5), // Ağustos K18 16.0
    sp("2026-09-01", 60, 0, 16.5, 5), // Eylül K18 16.5 → netHaric −0.5 düşer
  ];
  const gold = new Map<string, number>([["2026-08-28", 4400], ["2026-08-31", 4400], ["2026-09-01", 4400]]);
  const out = computeFxFlow(swap, fxWeekly, gold);
  const p = out[0]!;
  assert.ok(Math.abs(p.deltaNetHaric - -0.5) < 1e-9, "ham Δ swap hariç −0.5");
  assert.ok(Math.abs(p.swapRevision - -0.5) < 1e-9, "swapRevision = −ΔyabanciMb = −0.5");
  assert.equal(p.goldPriceEffect, 0, "fiyat sabit → Γ 0");
  assert.ok(Math.abs((p.fxFlow ?? 1) - 0) < 1e-9, "revizyon akım değil → fxFlow 0");
});

test("computeFxFlow: altın fiyatı eksik gün → gold + fxFlow null (taşıma YOK); kamu null → fxFlow null", () => {
  const goldMissing = new Map<string, number>([["2026-09-04", 4453], ["2026-09-11", 4339]]); // 10-09 yok
  const out = computeFxFlow(fxSwap, fxWeekly, goldMissing);
  assert.equal(out[0]!.goldPriceEffect, null, "04→10: 10-09 fiyatı yok → null");
  assert.equal(out[0]!.fxFlow, null);
  assert.equal(out[1]!.goldPriceEffect, null, "10→11: 10-09 fiyatı yok → null");
  assert.ok(Math.abs(out[1]!.deltaNetHaric - (-1.964 - 0.132)) < 1e-6, "delta yine dolu");
  const kamuNull = computeFxFlow(
    [fxSwap[0]!, fxSwap[1]!, { ...fxSwap[2]!, kamu: null }],
    fxWeekly,
    fxGold,
  );
  assert.equal(kamuNull[1]!.kamuDelta, null);
  assert.equal(kamuNull[1]!.fxFlow, null, "kamu yoksa fxFlow null");
  assert.notEqual(kamuNull[1]!.goldPriceEffect, null, "gold yine hesaplanır");
});

test("computeFxFlow: < 2 nokta → []; boş harita → gold/fx null, delta dolu", () => {
  assert.deepEqual(computeFxFlow([fxSwap[0]!], fxWeekly, fxGold), []);
  assert.deepEqual(computeFxFlow([], fxWeekly, fxGold), []);
  const out = computeFxFlow(fxSwap, fxWeekly, new Map());
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.goldPriceEffect === null && p.fxFlow === null && Number.isFinite(p.deltaNetHaric)));
});
