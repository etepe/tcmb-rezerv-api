# CLAUDE.md — tqrlab TCMB Rezerv Dashboard

## Project Overview
TCMB uluslararası rezervlerini canlı izleyen, tqrlab markalı bir dashboard. Veri TCMB
EVDS3'ten çekilir; EVDS anahtarı HTTP header'ında gittiği ve CORS olmadığı için tarayıcıdan
çağrılamaz → bir Cloudflare Worker proxy (anahtar secret'ta) veriyi çeker, hesaplar, KV'de
cache'ler ve JSON sunar. Frontend Astro + React island (tqrlab.com altyapısı, `/yz-model-takip`
deseni). Hesaplama mantığı `tcmb_reserves.py` (Python) ile **doğrulandı**; Worker bunu TS'e port eder.

## Architecture (özet)
`EVDS3 → evds-client (M-001) → reserve-engine (M-002) → api-worker (M-003) ↔ KV → dashboard-ui (M-004)`.
Cron ön-ısıtma (M-005, Faz 4). Detay: `docs/architecture.md`. **evds-client dışında hiçbir modül EVDS'e dokunmaz.**

## Tech Stack
- Backend: Cloudflare Worker (TypeScript), KV cache, Cron Trigger
- Frontend: Astro + React islands, Recharts, Tailwind (+ tqrlab CSS değişkenleri)
- Araçlar: pnpm, wrangler, Astro CLI
- Anahtar: `TCMB_EVDS_KEY` → **Worker secret** (`wrangler secret put TCMB_EVDS_KEY`). Asla client'a, asla repoya.

## Brand / Design System (tqrlab — dark / internal-research)
CSS değişkeni olarak tanımla, hardcode etme:
```css
--bg:    #060A14;  /* deep navy arka plan */
--panel: #0C1322;  /* kart/panel yüzeyi */
--grid:  #1B2436;  /* ızgara çizgileri (chart) */
--text:  #C9D4E5;  --muted: #5B6B86;
--blue:  #58A6FF;  --green: #3FB950;  --amber: #D29922;  --red: #F85149;
```
- Fontlar: başlıklar **DM Sans**, veri/sayılar **JetBrains Mono** (fallback Calibri / Consolas).
- **%4 opaklıkta grid overlay** sayfa arka planında.
- Vurgu çizgilerinde **mavi glow** (subtle box-shadow/`drop-shadow`).
- **Sol-kenarlıklı metric kartları** (left border accent renk: artış yeşil, azalış kırmızı, nötr mavi).
- Wordmark/footer: yalnızca küçük harf **tqrlab**. "Tepe Quant Research" / "FETM" KULLANMA.
- Chart renkleri: Döviz = `--blue`, Altın = `--amber`, nowcast kuyruğu = `--green` (kesikli), zirve = `--red`, güncel = `--green`.

## Veri Katmanı — EVDS3 (Worker'da TS'e port; formüller doğrulanmıştır)
**Endpoint:** `https://evds3.tcmb.gov.tr/igmevdsms-dis/` (eski `/service/evds` ÖLÜ — kullanma).
**Çağrı:** `GET {base}series={KODLAR}&startDate={dd-mm-yyyy}&endDate={dd-mm-yyyy}&type=json`
- Çoklu seri kodu `-` ile birleşir: `TP.AB.TOPLAM-TP.AB.C2-TP.AB.C1`.
- **Anahtar HTTP header'ında:** `{ "key": <TCMB_EVDS_KEY> }` (2024 sonrası kural; URL'de DEĞİL).
- Yanıt: `{ "items": [ { "Tarih": "12-06-2026", "TP_AB_TOPLAM": "152081.1", ... } ] }`.
  Kodlardaki nokta yanıtta **alt çizgi** olur (`TP.AB.C2` → `TP_AB_C2`). Değerler string → float. Boş = `null`.
- JSON dönmezse (content-type html ise) → anahtar/uç hatası, `evds_auth_failed` fırlat.

**Seriler:**
| Amaç | Kod | Frekans | Birim |
|---|---|---|---|
| Toplam brüt rezerv | `TP.AB.TOPLAM` | Haftalık (Cuma) | milyon USD |
| Döviz (altın hariç) | `TP.AB.C2` | Haftalık (Cuma) | milyon USD |
| Altın | `TP.AB.C1` | Haftalık (Cuma) | milyon USD |
| Dış Varlıklar (analitik bilanço) | `TP.AB.A02` | İş günü | bin TL |
| Toplam Döviz Yükümlülükleri | `TP.AB.A10` | İş günü | bin TL |
| USD alış kuru | `TP.DK.USD.A.YTL` | İş günü | TL |
| Toplam YP mevduat | `TP.HPBITABLO4.1` | Haftalık (Cuma) | milyon USD |
| Yurt içi yerleşik YP mevduat | `TP.HPBITABLO4.2` | Haftalık (Cuma) | milyon USD |
| YDY menkul kıymet (Faz 7) hisse stok/net | `TP.MKNETHAR.M1` / `.M7` | Haftalık (Cuma) | milyon USD |
| YDY menkul kıymet DİBS stok/net | `TP.MKNETHAR.M2` / `.M8` | Haftalık (Cuma) | milyon USD |
| YDY menkul kıymet ÖST stok/net | `TP.MKNETHAR.M6` / `.M12` | Haftalık (Cuma) | milyon USD |

**Hesaplama (hepsi milyar USD çıktı):**
```
# Haftalık brüt rezerv:  değer_mlr = değer_milyon / 1000
toplam = TP.AB.TOPLAM/1000 ;  doviz = TP.AB.C2/1000 ;  altin = TP.AB.C1/1000

# Günlük Dış Varlıklar (USD, milyar):
disVarlikUsd(t) = TP.AB.A02(t) / TP.DK.USD.A.YTL(t) / 1e6      # A02 bin TL → milyar USD
NIR(t)          = (TP.AB.A02(t) - TP.AB.A10(t)) / TP.DK.USD.A.YTL(t) / 1e6

# GÜNLÜK BRÜT REZERV NOWCAST (resmi haftalık ~1 hafta gecikmeli; bununla güncelle):
#   çıpa = aralıktaki SON resmi haftalık 'toplam' (ör. son Cuma)
#   çıpa günü günlük seride de olmalı (Cuma iş günüdür → vardır)
brutRezerv(t) = toplam(çıpa_cuma) + ( disVarlikUsd(t) - disVarlikUsd(çıpa_cuma) )
# >>> Bu formül Bürümcekçi-tarzı analist tablosunu ±0,03 ile birebir verir (test edildi). <<<

# Dolarizasyon: değer_mlr = değer_milyon / 1000
ypToplam = TP.HPBITABLO4.1/1000 ;  ypYurtici = TP.HPBITABLO4.2/1000

# Swap AYRIŞTIRMASI — Faz 5'te API'ye KODLANDI (/api/summary.swap). Bkz. research-swap-split-method.md.
#   yerli_banka = (TP.SWAPTEKTAR.TOTALSTOKALIMYONLU − …TOTALSTOKSATIMYONLU)/1000   # GÜNLÜK, EVDS oto
#   yabanci_mb  = |TP.DOVVARNC.K18|/1000  # AYLIK adım (oto); K18 çekilemezse env YABANCI_MB_FALLBACK=16.4
#   toplam_swap = yabanci_mb + yerli_banka ;  net_dahil = (A02−A11−A14)/USD/1e6 (≡ NIR + A13)
#   swapHaricNet = net_dahil − toplam_swap   # 41 analist tablosu: ort artık ~0,3 mlr (08.04+ : ≤0,5)
#   SummaryResponse.swap: SwapPoint[]; meta.swapMbSource ("evds:K18"|"fallback") + meta.swapMb. Soft-fail ([]).
#   [UI (tqrlab.com) Faz 5'te TAMAM: manuel ?swap= girdisi KALDIRILDI → UI API'nin swap'ını tüketir. Caveat korunur:
#    "swap hariç net rezerv" kanonik değil → üçüncü taraf rakamına birebir oturmayabilir.]
```
**Doğrulama referansı (kabul testi):** çıpa 12-06-2026 toplam=152.08; nowcast 17/18/19-06 = 164.2 / 159.4 / 157.1.
Baz 27-02-2026 = toplam 210.3 / altın 136.8 / döviz 73.4.

## Deployment (kilitli kararlar — 2026-06-22)
- **UI:** tqrlab.com Astro repo'suna **yeni route** `/tcmb-rezerv-takip` (`/yz-model-takip` deseni). Standalone repo değil.
- **API:** **yeni `tcmb-rezerv-api` Worker'ı** (agent-lab-api genişletilmez). `wrangler.toml → name = "tcmb-rezerv-api"`.
- **Cache TTL:** haftalık ~6 sa (21600 s); günlük iş saatlerinde ~1 sa (3600 s). TTL'ler env/var'dan okunur.
- **Cron (Faz 4):** TCMB analitik bilanço yayım saatine göre KV ön-ısıtma.
- **Erişim:** sayfa **public** (Cloudflare Access gating yok).

## Current Status
- Phase **6**: günlük altın-fiyat değerleme etkisi ayrıştırması (API) → "Rezerv akışı" barlarını altın
  fiyat etkisi vs diğer (döviz akışı + parite) olarak böler. API ✅ TAMAM; UI sürüyor.
- Phase **5**: otomatik swap ayrıştırması (API) + UI redesign (main+aside, otomatik swap, yeni grafikler) — ✅ TAMAM.
  Faz 4: Cron ön-ısıtma (sertleştirme) + light-tema paylaşım/PDF varyantı.
  API: `tcmb-rezerv-api.tepe-erdinc.workers.dev` · UI: `tqrlab.com/tcmb-rezerv-takip`. Faz 1-3 ✅ **CANLI**.
- Tamamlanan (Faz 1): M-001 (haftalık `fetchSeries`) + M-002 (`computeWeekly`/`weeklyMeta`) +
  M-003 (`GET /api/weekly` + KV cache + CORS + tanımlı hata kodları) + M-004 (haftalık stacked area, tqrlab dark).
- Tamamlanan (Faz 2): M-001 (+günlük A02/A10/USD; generic `fetchSeries`) + M-002 (`computeDailyNowcast`
  nowcast + NIR) + M-003 (`GET /api/summary` → `{weekly, daily, meta}`, `DAILY_TTL` KV cache) + M-004 UI nowcast kuyruğu + kartlar.
- Tamamlanan (Faz 3 — CANLI): M-001 (+haftalık `TP.HPBITABLO4.1/.2`) + M-002 (`computeDolarizasyon` → `DolarPoint[]`) +
  M-003 (`/api/summary.dolarizasyon`, **soft-fail**: EVDS hatasında `[]`, çekirdek dashboard düşmez). UI (tqrlab.com repo):
  dolarizasyon paneli (2 kart + trend) + manuel swap input (localStorage + `?swap=`) → **swap-hariç net (tqrlab tanımı)** + caveat.
- Tamamlanan (Faz 4 — Part A · cron): M-003 refactor → `src/summary.ts` (`buildWeekly`/`buildSummary` +
  KV cache helper'ları; HTTP handler + cron **aynı yol**, kopya yok) + M-005 (`src/scheduled.ts → warmCache`,
  `wrangler.toml [triggers]`). Cron `summary` **ve** `weekly` anahtarını ön-ısıtır → kullanıcı/smoke hep sıcak
  cache'e düşer ("bayat cache → smoke fail" sınıfı sorunu kapatır). **Public sözleşme değişmez.**
- Doğrulama: `pnpm typecheck` (strict, `any` yok) ✅; `pnpm test` (offline reserve-engine + `/api/summary`
  mock + **cron warm** mock; 16/16) ✅; `pnpm dry-run` ✅. CI `.github/workflows/deploy.yml` (check + deploy +
  smoke) **main'de yeşil** — smoke `/api/weekly` (152.08) + `/api/summary` yapısal (+ dolarizasyon alan/tip).
  Kabul (offline + canlı): çıpa 12-06 = 152.08; nowcast 17/18/19-06 = 164.2/159.4/157.1, NIR_19 ≈ 48.2;
  **dolarizasyon 12-06 = ypToplam 262.1 / ypYurtici 222.0**.
- Tamamlanan (Faz 4 — Part B · CANLI): light-tema paylaşım/PDF varyantı (tqrlab.com repo). `BaseLayout`
  head script `?theme=light|dark` + `?print=1` (boyamadan önce; URL override localStorage'a YAZILMAZ);
  `tqrlab.css` `@media print` + `:root[data-print="1"]` sade snapshot (yalnız bu sayfada yüklü → site geneli
  print bozulmaz); "Yazdır / PDF" (dark→light→print→restore) + "Paylaşım linki" (`?theme=light&swap=` panoya)
  araç çubuğu; swap girişi `no-print` (değer kart+notta kalır). tqrlab küçük harf + caveat paylaşım/PDF'te korunur.
  Doğrulama: `astro build` ✅; `astro check` 0 yeni hata; tarayıcı testi (dark/light/?print/mobil/paylaş/yazdır) ✅.
- Faz 4 — Part C (araştırma) → **ÇÖZÜLDÜ (2026-06-29 · research-swap-split-method.md).** 41 günlük analist
  tablosu (`Rezerv/`) + canlı EVDS: swap **AYRIŞIYOR** → Yerli banka = `TP.SWAPTEKTAR.TOTALSTOK(ALIM−SATIM)YONLU`/1000
  (GÜNLÜK, kesin; artık ≤0,33), Yabancı MB = 16,4 bakımlı sabit. swapHaricNet = (A02−A11−A14)/USD − 16,4 −
  SWAPTEKTAR_net → 40 noktada ort 0,3 mlr (08.04 sonrası 31/31 ≤0,5; erken offset analistin eski tablo tabanı).
  Önceki "manuel KALDI" sonucu (research-swap-nir-reproduction.md) düzeltildi → **Faz 5'te API'ye kodlandı**
  (`/api/summary.swap`; `computeSwapSplit`; K18 oto + `YABANCI_MB_FALLBACK`=16.4; soft-fail).
  typecheck + 21/21 test + dry-run + canlı smoke ✅.
- Tamamlanan (Faz 5 — UI redesign · tqrlab.com repo `Research_publishing_v0`, HANDOFF-reserve-ui-v2):
  **manuel swap girdisi KALDIRILDI** (`<input>`/`?swap=`/`localStorage`/paylaşım `&swap=` silindi) → UI
  API'nin otomatik `swap[]`'ini tüketir. Sayfa **ana grafik sütunu + sağ sticky aside** (güncel-değer kartları:
  brüt rezerv nowcast / NIR / swap hariç net / dolarizasyon) layout'una taşındı. Yeni bileşenler:
  `AsideMetricCard`, `ReserveChangeBars` (günlük rezerv-değişim barları, işaret-renk), `NirChart`
  (`connectNulls=false`), `SwapTrendChart` (netDahil vs netHaric), `utils.ts` (TR format + türev seri).
  `ReserveSwapCard` API swap'ını + kırılım + fallback rozetini gösterir; `ReserveMetricCards` haftalık manşete
  indirildi (NIR/nowcast aside'a → çift gösterim yok). Soft-fail (`swap:[]`/null nir/`dolarizasyon:[]` → "veri yok").
  Caveat + tqrlab marka + `?theme`/`?print` paylaşım/PDF korunur. Doğrulama: `astro build` ✅; `astro check`
  0 yeni hata; tarayıcı (desktop/mobil/fallback+stale/empty-swap) ✅. PR `Research_publishing_v0#29`.
- Tamamlanan (Faz 6 — Part A+B · API): araştırma kapısı (`research-gold-price-effect.md`) — altın rezervin
  ~%62'si; ima edilen miktar kısa pencerede sabit (ort 25,1M ons, CV %5,9; Mart sonu ~130 ton GERÇEK satış);
  oran-bazlı yöntem doğrulandı. `src/gold-client.ts` (HARİCİ altın fiyatı — Yahoo GC=F; EVDS-only kuralına dar
  istisna, soft-fail), `computeGoldPriceEffect` (saf, çıpadan beri kümülatif `anchorAltin×(fiyat(t)/fiyat(çıpa)−1)`),
  `DailyPoint.goldPriceEffect` + `meta.goldPriceSource` ("external:yahoo-gcf"|"unavailable"). Soft-fail: altın
  çekilemezse `null` + kaynak `unavailable` (çekirdek nowcast düşmez). typecheck + 27/27 test + dry-run ✅.
- Tamamlanan (Faz 7 — API + UI): yurt dışı yerleşiklerin menkul kıymet (hisse/DİBS/ÖST) alım-satım
  istatistikleri. API: `ForeignSecPoint` (hisse/DİBS/ÖST × net akım `*Flow` + stok `*Stock`, mlr USD),
  `computeForeignSecurities` (dolarizasyon deseni; /1000; kısmi haftaya toleranslı), `buildSummary`'de
  **soft-fail** blok (`SummaryResponse.foreignSecurities`; EVDS hatasında `[]`, çekirdek düşmez).
  UI (`Research_publishing_v0`): sayfa içi **sekme çubuğu** (`ReserveTabBar`: Rezervler | Yurtdışı Menkul
  Kıymet) + `ForeignSecStockChart` (stacked area stok) + `ForeignSecFlowBars` (işaret-yığılmış net akım)
  + `ForeignSecView`; aside sekmeye göre değişir (hisse/DİBS/ÖST net akım + toplam stok kartları).
  typecheck + 34/34 test + dry-run ✅; astro build ✅. **Seri kodları TEYİT EDİLDİ** (kullanıcı EVDS
  ekran görüntüsü): datagroup `bie_mknethar` → hisse `M1`/`M7`, DİBS `M2`/`M8`, ÖST `M6`/`M12`
  (stok/net; "Yurt İçi Piyasa" alt-kalemleri). Birim milyon USD → /1000.
- Blocked by: yok. **Çekirdek dashboard + sertleştirme + Faz 5 swap + Faz 6 altın-fiyat + Faz 7 YDY menkul kıymet (API+UI) TAMAM.**

## Development Commands
```
# Worker (api)
pnpm i
wrangler secret put TCMB_EVDS_KEY        # anahtarı gir (interaktif)
wrangler kv namespace create REZERV_CACHE
wrangler dev                              # yerel
wrangler deploy

# UI (astro)
pnpm i
pnpm dev
pnpm build && wrangler pages deploy dist  # ya da mevcut Pages projesine route
```

## Module Map
> Not: bu repo **= `tcmb-rezerv-api` Worker'ı** → API kökte `src/`. UI ise tqrlab.com Astro
> repo'suna drop-in (`ui/` altında stage'lenir; bkz. `ui/README.md`).

| Module | Path | Status | Agent |
|---|---|---|---|
| M-001 evds-client | `src/evds-client.ts` | ✅ Faz 1-3 (haftalık + günlük + YP mevduat; generic) | sonnet |
| M-001b gold-client | `src/gold-client.ts` | ✅ Faz 6 (HARİCİ altın fiyatı — Yahoo GC=F; EVDS-only'a dar istisna, soft-fail) | opus |
| M-002 reserve-engine | `src/reserve-engine.ts` | ✅ Faz 1-6 (`computeWeekly`/`weeklyMeta`/`computeDailyNowcast`/`computeDolarizasyon`/`computeSwapSplit`/`computeGoldPriceEffect`) | opus |
| M-003 api-worker | `src/index.ts` (+ `src/summary.ts`) | ✅ Faz 1-6 (`/api/weekly` + `/api/summary` [+ `dolarizasyon`/`swap`/`goldPriceEffect` soft-fail]; fetch+compute+cache `summary.ts`'te, HTTP+cron paylaşır) | sonnet |
| M-004 dashboard-ui | tqrlab.com repo: `src/components/reserve/*` (`ReserveDashboard`/`AreaChart`/`MetricCards`/`Dolarizasyon`/`SwapCard` + Faz 5: `AsideMetricCard`/`ReserveChangeBars`/`NirChart`/`SwapTrendChart`/`utils`) | ✅ Faz 1-5 (CANLI; light-tema paylaşım/PDF; Faz 5 redesign: main+aside, otomatik swap, yeni grafikler) | sonnet |
| M-005 scheduled-refresh | `src/scheduled.ts` | ✅ Faz 4 — cron KV ön-ısıtma (`warmCache` → `summary`+`weekly`; `[triggers]` wrangler.toml) | haiku |

## Conventions
- TS strict; `any` yok. Para birimleri `number` (milyar USD), tarihler ISO `string`.
- Tüm dış değerler tipli arayüzden geçer: `WeeklyPoint`, `DailyPoint`, `DolarPoint`, `Summary` (bkz. `api/src/types.ts`).
- Hata yönetimi: Worker tanımlı hata kodları döner (`evds_unavailable`, `evds_auth_failed`, `empty_series`, `upstream_timeout`) — 5xx + JSON `{error}`.
- Marka renkleri **yalnızca** CSS değişkeninden; bileşende hex hardcode etme.
- Sayı formatı: TR yerel (binlik nokta, ondalık virgül) gösterimde; veri katmanında nokta-ondalık `number`.
- Commit/PR'da feature ID izi: `F-xxx → M-xxx`.

## What NOT to Do
- ❌ EVDS anahtarını client'a sızdırma / repoya koyma / URL query'ye yazma. **Yalnız Worker secret + header.**
- ❌ Tarayıcıdan doğrudan EVDS'e fetch (CORS + anahtar sızıntısı).
- ❌ Eski `/service/evds` ucunu kullanma (ölü — SPA döner).
- ❌ Nowcast/NIR formülünü "iyileştirme"/yeniden tasarlama — `tcmb_reserves.py`'de doğrulandı, birebir port et.
- ❌ Günlük altın/döviz **seviye (stok) ayrımını uydurma** (günlük altın/döviz stok ayrımı EVDS'de yok; seviye ayrımı haftalık kalır).
  ✓ Faz 6: günlük altın **fiyat-DEĞİŞİM etkisi** ayrı (harici altın fiyatı + haftalık C1, oran-bazlı; `computeGoldPriceEffect`) —
  bu seviye ayrımı değil, değerleme etkisidir; "diğer" segmenti FX paritesini içerir (saf müdahale değil, caveat korunur).
- ❌ Fazın ötesine geçme. Faz 1 deploy edilip gözden geçirilmeden Faz 2 kodu yazma (BDUF yok).
- ❌ Jenerik "admin template" görünümü. tqrlab token'ları + DM Sans/JetBrains Mono + sol-kenarlıklı kartlar şart.
