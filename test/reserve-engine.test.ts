// M-002 offline birim testi (ağ/secret gerektirmez).
// computeWeekly /1000 dönüşümü, ISO tarih, sıralama, peak/latest mantığını doğrular.
// Çalıştır: node --test --experimental-strip-types
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeekly, weeklyMeta, EngineError } from "../src/reserve-engine.ts";
import type { RawRow } from "../src/types.ts";

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
