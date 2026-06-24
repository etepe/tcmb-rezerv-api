// M-002 offline birim testi (ağ/secret gerektirmez).
// computeWeekly /1000 dönüşümü, ISO tarih, sıralama, peak/latest mantığını doğrular.
// Çalıştır: node --test --experimental-strip-types
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDailyNowcast,
  computeDolarizasyon,
  computeWeekly,
  EngineError,
  weeklyMeta,
} from "../src/reserve-engine.ts";
import type { RawRow, WeeklyPoint } from "../src/types.ts";

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
