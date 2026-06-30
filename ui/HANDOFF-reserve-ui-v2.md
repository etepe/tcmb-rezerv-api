# UI HANDOFF v2 — Rezerv dashboard redesign (aside + otomatik swap + yeni grafikler)

> **Hedef repo:** `etepe/Research_publishing_v0` (tqrlab.com Astro sitesi) — route `/tcmb-rezerv-takip`.
> **Bu repo değil.** Bu doküman tasarımı tarifler; uygulama orada yapılır. Worker/API tarafı (Faz 5) **CANLI**.
> v1 (`HANDOFF-swap-ui.md`) yalnız swap manuel-girdi kaldırmayı kapsıyordu; **v2 onu kapsar + genişletir**
> (sağ aside, swap zaman serisi, NIR trend, dolarizasyon trend, günlük rezerv-değişim bar grafiği).
>
> **Uygulama oturumu ön-koşulu:** hem `etepe/tcmb-rezerv-api` (API tipleri/referans) hem
> `etepe/Research_publishing_v0` (UI) oturuma yetkili olmalı. add_repo ile ekle, `claude/swap-ui-design-oyase2`
> feature branch'inde çalış.

---

## 0. Neden / amaç
`tcmb-rezerv-api` Faz 5'te swap ayrıştırmasını API'ye kodladı: `GET /api/summary` artık günlük `swap[]` +
`meta.swapMb*` döner. Canlı dashboard ise hâlâ **manuel swap `<input>` + `?swap=` + localStorage** kullanıyor
(eski yöntem). Bu redesign: (1) manuel girdiyi kaldırıp API'nin otomatik swap'ını tüketir, (2) sayfayı
**ana grafik alanı + sağ aside (güncel-değer metric kart sütunu)** layout'una taşır, (3) yeni görseller ekler.

---

## 1. API sözleşmesi (tek fetch: `GET /api/summary`) — DEĞİŞMEZ
```jsonc
{
  "weekly":      [{ "tarih":"2026-06-12", "toplam":152.08, "doviz":..., "altin":... }],   // haftalık, mlr USD
  "daily":       [{ "tarih":"2026-06-19", "brutRezerv":157.1, "nir":48.2 }],              // günlük nowcast; nir number|null
  "dolarizasyon":[{ "tarih":"2026-06-12", "ypToplam":262.1, "ypYurtici":222.0 }],         // haftalık YP mevduat, mlr USD
  "swap": [
    { "tarih":"2026-06-26", "netDahil":47.3, "yabanciMb":16.36,
      "yerliBanka":-2.12, "toplamSwap":14.24, "netHaric":33.1 }                           // günlük, mlr USD
  ],
  "meta": {
    "anchorDate":"2026-06-12", "anchorBrut":152.08, "peak":{ "tarih":..., "toplam":... },
    "latestWeekly":"2026-06-12", "latestDaily":"2026-06-19", "updatedAt":"<ISO>",
    "unit":"milyar USD", "source":"TCMB EVDS",
    "swapMbSource":"evds:K18",   // "evds:K18" | "fallback"
    "swapMb":16.36,              // hesapta kullanılan Yabancı MB (mlr USD)
    "cached":true, "stale":false // stale opsiyonel: true ise son-bilinen-iyi (eski) veri
  }
}
```
Tipler (referans, değişmez): `etepe/tcmb-rezerv-api → src/types.ts` (`WeeklyPoint`/`DailyPoint`/`DolarPoint`/
`SwapPoint`/`SummaryResponse`/`SummaryMeta`).

**Soft-fail:** `swap` ve `dolarizasyon` `[]` gelebilir (EVDS hatasında). `nir` nokta-bazında `null` olabilir.
UI bunların hepsinde **çökmeden "veri yok"a** düşmeli.

---

## 2. Layout — `ReserveDashboard` kök grid (main + sağ aside)
- **Desktop (≥1024px):** `grid-template-columns: minmax(0, 1fr) 320px; column-gap: 24px;`
  - `minmax(0, 1fr)` **şart** — düz `1fr` Recharts `ResponsiveContainer`'ı viewport'tan taşırır.
  - Sol = grafikler (main). Sağ = aside.
  - Aside: `position: sticky; top: 16px; align-self: start;` (kartlar scroll'da görünür kalır), iç dikey flex `gap:16px`.
- **Tablet (640–1023px):** tek sütun, **aside main'in ÜSTÜNDE** (güncel değerler önce), aside `repeat(2,1fr)` → 2×2 kart.
- **Mobile (<640px):** tek sütun, aside üstte, kartlar tam genişlik (1 sütun); grafik yükseklikleri ~220px.
- Header/araç çubuğu en üstte, `grid-column: 1 / -1`. Konteyner `max-width ≈ 1180px`, ortalı, yatay padding ~24px.
  4% grid overlay (`.tqr-grid-overlay`) + `--bg` kök korunur.

---

## 3. Ana sütun — bölüm sırası (anlatı: manşet → akış → yapı)
1. **Header band:** başlık, `meta.updatedAt`, kaynak, `stale` rozeti, **paylaşım/PDF araç çubuğu** (`no-print`).
2. **MetricCards** (mevcut, haftalık manşet: toplam / döviz / altın / peak). Aside ile **çift gösterimi önle** —
   günlük/türev değerler aside'a; çakışırsa (ör. NIR) aside sahiplenir, üst stripten düşür.
3. **AreaChart** (mevcut hero, ~360px): stacked döviz+altın, toplam çizgisi, zirve(kırmızı)/güncel(yeşil) nokta.
4. **Grup "Rezerv akışı / flows":**
   - 4a. **ReserveChangeBars** (YENİ) — günlük brüt rezerv değişim barları (alış/satış).
   - 4b. **NirChart** (YENİ) — günlük NIR trendi.
5. **Grup "Swap":**
   - 5a. **SwapCard** (yeniden kablolandı) — güncel net değerler + kırılım + kaynak rozeti.
   - 5b. **SwapTrendChart** (YENİ) — netDahil vs netHaric zaman serisi.
6. **Dolarizasyon** (mevcut, trend grafiğine genişletilir) — yapısal bağlam, en sonda.
7. **Footer:** küçük harf **tqrlab** + caveat/yöntem notu + kaynak.

---

## 4. Aside — güncel-değer metric kart sütunu (4 kart)
Her kart `.tqr-card` (sol-kenar accent). İçerik: etiket (DM Sans, `--muted`), büyük değer (JetBrains Mono),
delta chip (`▲/▼` + işaretli TR sayı; `--up` yeşil / `--down` kırmızı), alt satır. TR sayı formatı (binlik nokta,
ondalık virgül). **Eksik veride kart kabuğu KALIR → "veri yok", nötr `--grid` accent** (layout kaymaz).

| Kart | Değer | Delta | Alt satır | Accent | Eksik |
|---|---|---|---|---|---|
| **A · Brüt rezerv (nowcast)** | son `daily.brutRezerv` | son − önceki günlük | `çıpa {anchorBrut} ({anchorDate})` | delta işareti | daily boş → "veri yok" |
| **B · NIR** | son **null-olmayan** `daily.nir` (sondan geriye yürü) | önceki null-olmayan'a göre | o okumanın tarihi | delta işareti | hepsi null → "veri yok" |
| **C · Swap hariç net** (YENİ) | son `swap.netHaric` | önceki swap noktası | ikincil `netDahil: {…}` | delta işareti | `swap===[]` → "veri yok" |
| **D · Dolarizasyon özeti** | son `dolarizasyon.ypToplam` | önceki haftalık ypToplam | `yurt içi {ypYurtici}` (+ %pay opsiyonel) | nötr `--blue` (iyi/kötü değil) | boş → "veri yok" |

- **C kartı + SwapCard:** `meta.swapMbSource === "fallback"` ise küçük amber **"MB tahmini (sabit)"** rozeti; `"evds:K18"` → rozet gizli.
- **`meta.stale` truthy** ise aside başında **tek** amber "gecikmiş veri" pill (kart başına değil) + `updatedAt` hep görünür.

---

## 5. Bileşen planı (tek-fetch deseni KORUNUR)
`ReserveDashboard` `/api/summary`'yi **bir kez** çeker, tipli dilimleri (`weekly`/`daily`/`dolarizasyon`/`swap`/`meta`)
prop olarak iletir. **Çocuk bileşenler fetch ETMEZ.** Türev seriler (`dailyChange`, `latestNonNullNir`) burada
ya da saf helper'da bir kez hesaplanır → çocuklar sunum-odaklı (dumb) kalır.

### Değişen
- **`ReserveDashboard.tsx`** — main+aside grid sarmalayıcı + aside kart stack; dilim prop'ları; türev hesap;
  varsa kök seviyedeki `?swap=` okuma temizliği.
- **`SwapCard.tsx`** — **SİL:** `<input>`, `?swap=` parse, `localStorage` swap oku/yaz, paylaşım-linkindeki `&swap=`.
  **Yeni prop'lar:** `swap: SwapPoint[]`, `swapMbSource`, `swapMb`. **İçerik:** `netHaric` (büyük, JetBrains Mono) +
  kırılım `Toplam swap = toplamSwap` / `├ Yabancı MB = yabanciMb` / `└ Yerli banka = yerliBanka` + ikincil
  `Net dış varlık (swap dahil) = netDahil` + caveat + fallback rozeti. Kenarlık: netHaric ↑ `--green` / ↓ `--red` / nötr `--blue`.
  `swap===[]` → tüm kart "veri yok".
- **`Dolarizasyon.tsx`** — özet + ypToplam/ypYurtici **trend çizgisine** genişlet (mevcut eksen/format setup'ını yeniden kullan).
- **Paylaşım/PDF araç çubuğu** — serileştirmeden `swap` çıkar; `theme`/`print` KALIR. Paylaşım linki `?theme=light` (+ `print=1` PDF'te); `swap=` YOK.
- **`MetricCards.tsx`** — aside ile çakışan kartı kırp (gerekirse); yoksa dokunma.

### Yeni
- **`ReserveChangeBars.tsx`** — props `{ daily: DailyPoint[] }`. Recharts `BarChart`; işaret-bazlı `<Cell fill>`.
- **`NirChart.tsx`** — props `{ daily: DailyPoint[] }`. `LineChart`, `connectNulls={false}` (boşluklar görünür kırılır).
- **`SwapTrendChart.tsx`** — props `{ swap: SwapPoint[] }`. İki `Line`: `netDahil` + `netHaric`. `swap===[]` → "veri yok" placeholder.
- **`AsideMetricCard.tsx`** (opsiyonel paylaşık) — jenerik güncel-değer kartı (etiket/değer/delta chip/alt satır/accent/
  kaynak rozeti/"veri yok"). Dört aside kartı bunun örneği → format + eksik-veri mantığı tek yerde.

### Yeniden kullanılacak (yeni kod yazma)
- **`readVar` / `useBrandColors`** — CSS-var → Recharts renk köprüsü. Referans: bu repo `ui/src/components/reserve/
  ReserveAreaChart.tsx:47-65`. (tqrlab.com'da büyük ihtimalle aynısı var; yoksa bu dosyadan port et.) Hex hardcode YOK.
- Mevcut TR sayı/tarih formatlayıcıları (`Intl.NumberFormat("tr-TR")`, `ReserveAreaChart.tsx:67-79`).
- Yeni `deltaSeries` / `latestNonNull` / `pctShare` saf yardımcıları → küçük `src/components/reserve/utils.ts`
  (varsa oraya; yoksa `ReserveDashboard` içinde colocate).

---

## 6. Günlük rezerv-değişim bar türetimi (4a)
Girdi: `daily: DailyPoint[]`, `tarih`'e göre artan sıralı.
```
change[i] = daily[i].brutRezerv − daily[i-1].brutRezerv      // i = 1 .. n-1
datum     = { tarih: daily[i].tarih, delta: change[i], prev: daily[i-1].tarih }
```
- **İlk nokta (i=0) BAR ÜRETMEZ** (mutlak değeri çizme; seriye 1'den başla).
- **Renk (işaret-bazlı, `<Cell>`):** `delta > 0` → `--green` (rezerv artışı / **döviz alımı / birikim**);
  `delta < 0` → `--red` (rezerv azalışı / **döviz satışı**); `delta === 0` → nötr `--grid`/`--muted`.
- **Tooltip:** işaretli TR delta + tarih çifti (`{prev} → {tarih}`). Legend: "artış / azalış".
- **Boşluk/haftasonu:** nowcast "günlük" ama gerçek veri hafta sonu/tatil atlar. **Önceki *mevcut* noktaya göre
  delta** kullan (sentetik sıfır EKLEME); tooltip gerçek önceki tarihi gösterir → Cuma→Pazartesi farkı tek bar,
  yanlış "tek günlük" okuması olmaz. Null/eksik `brutRezerv` → o noktayı atla, son geçerliye karşı delta.
- **X-ekseni:** seyrek tick (ör. haftalık) — günlük bar serisinde etiket kalabalığı önlenir.
- **Veri kaynağı kararı:** birincil = `brutRezerv` günlük farkı (her iş günü mevcut, ek API yok; döviz alış/satış
  müdahalesinin en doğrudan vekili). Alternatif istenirse NIR farkına çevrilebilir — ama varsayılan brutRezerv.

---

## 7. Responsive + Print
- **Print (`?print=1`):** aside `position: static` + grafiklerin **üstüne** kompakt KPI stripe (sticky 320px rail
  PDF'te bozuk davranır); grid tek sütun (PDF dar); Recharts için `@media print` **sabit px yükseklik**
  (reflow'da sıfırlanmasın). **`no-print`:** araç çubuğu butonları, tema toggle, dış linkler.
  **Korunur (print'te görünür):** tüm veri, caveat, kaynak, `updatedAt`, stale rozeti, tqrlab footer.
- Mevcut light-tema/print mekanizması (`BaseLayout` head script `?theme=light|dark` + `?print=1`, `tqrlab.css`
  `@media print` / `:root[data-print="1"]`) **bozulmadan korunur**. URL override localStorage'a yazılmaz. Link'te `swap=` yok.

---

## 8. Riskler / edge-case
- **`swap===[]`:** SwapCard + SwapTrendChart + aside C → hepsi "veri yok", throw YOK. `.at(-1)`/`map` öncesi `swap?.length` guard. Paylaşım linki swap'a bağımlı değil.
- **Null NIR:** `NirChart` `connectNulls={false}`; aside B son null-olmayana yürür; null'da `.toFixed` çağırma.
- **`swapMbSource==="fallback"`:** SwapCard + aside C amber rozet; `"evds:K18"` → rozet yok.
- **`meta.stale`:** tek amber pill + `updatedAt` hep görünür (grafik grileştirilmez).
- **Recharts renk:** hex hardcode YOK → `readVar`/`useBrandColors`. CSS-var SSR'da okunamaz; island'lar client-side
  olduğu için sorun yok ama ilk paint için **fallback renk sabiti** (readVar boş dönerse).
- **Astro island hydration:** CSS-var okuma / eski localStorage temizliği / paylaşım-linki üretimi `window`-guard'lı (client-side).
  Eski swap localStorage anahtarı zararsız → temizliği opsiyonel.
- **`minmax(0,1fr)` + `width:100%` konteyner** — Recharts taşmasını önler (kritik).
- **Sayı formatı:** tüm değerler mevcut TR formatlayıcıdan; delta işaretli; yeni `Intl` örneği açma (locale drift).
- **Çift değer (main vs aside):** haftalık manşet üst MetricCards'ta, günlük/türev aside'da — aynı sayıyı iki kez gösterme (özellikle NIR).

---

## 9. Marka / tasarım token'ları (hardcode YOK — CSS değişkeni)
`--bg #060A14 · --panel #0C1322 · --grid #1B2436 · --text #C9D4E5 · --muted #5B6B86 ·
--blue #58A6FF · --green #3FB950 · --amber #D29922 · --red #F85149`. Başlık **DM Sans**, veri/sayı **JetBrains Mono**.
Sol-kenarlıklı kartlar (`.tqr-card` / `--up` / `--down`). Footer küçük harf **tqrlab** ("Tepe Quant Research"/"FETM" KULLANMA).
Chart renkleri: Döviz `--blue`, Altın `--amber`, nowcast/artış `--green`, zirve/azalış `--red`.
Token referansı: bu repo `ui/src/styles/tqrlab.css` (tqrlab.com global stiline ekli olmalı).

**Caveat metni (KORUNUR, küçük `--muted`):** *"'Swap hariç net rezerv' kanonik bir tanım değildir; kullanılan swap
bileşenlerine göre üçüncü taraf rakamlarıyla farklılaşabilir. Yabancı MB swapı aylık (TCMB SDDS) tahmindir."*

---

## 10. Kabul kriterleri (uygulama oturumu)
- [ ] Sayfada hiçbir manuel swap input / `?swap=` / localStorage swap izi yok (grep ile teyit); paylaşım linkinde `swap=` yok.
- [ ] Layout: desktop main+sticky aside; tablet/mobil aside üstte; Recharts taşma yok (`minmax(0,1fr)`).
- [ ] Aside 4 kart (brüt rezerv / NIR / swap hariç net / dolarizasyon) doğru değer + delta + eksik-veri durumu.
- [ ] SwapCard `netHaric` + Yabancı MB/Yerli banka/Toplam kırılımı + ikincil netDahil + caveat + (fallback'te) rozet.
- [ ] Yeni grafikler: ReserveChangeBars işaret-renk (yeşil/kırmızı) + i=0 bar yok; NirChart null-kırılma; SwapTrendChart 2 çizgi; Dolarizasyon trend.
- [ ] Soft-fail: `swap:[]` / hepsi-null nir / `dolarizasyon:[]` → ilgili bölümler "veri yok", sayfa çökmüyor.
- [ ] `?theme=light&print=1` PDF/paylaşım bozulmamış; caveat + tqrlab marka korunmuş.
- [ ] `astro build` + `astro check` temiz (0 yeni hata).
- [ ] Commit (F-Faz5 → M-004 izi) + push `claude/swap-ui-design-oyase2` + draft PR.

---

## 11. Kritik dosyalar
- **tqrlab.com (`etepe/Research_publishing_v0`):** `src/components/reserve/{ReserveDashboard,SwapCard,Dolarizasyon,
  MetricCards}.tsx`; yeni `{ReserveChangeBars,NirChart,SwapTrendChart,AsideMetricCard}.tsx` + `utils.ts`;
  `src/pages/tcmb-rezerv-takip.astro`; `tqrlab.css`; `BaseLayout` head script.
- **tcmb-rezerv-api (bu repo, referans):** `src/types.ts` (tipler), `ui/src/components/reserve/ReserveAreaChart.tsx`
  (readVar/useBrandColors + formatlayıcı deseni), `ui/src/styles/tqrlab.css` (token), `research-swap-split-method.md`
  (swap yöntemi + doğrulama), `ui/HANDOFF-swap-ui.md` (v1 — swap rewire detayı).
