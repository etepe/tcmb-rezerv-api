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

# Swap (seri SONRA gelecek): kullanıcı UI'dan swap stoku (mlr$) girer →
#   swapHaricNet = NIR - swap   [UI'da caveat: tanım/yükümlülük farkı nedeniyle
#   üçüncü taraf 'swap hariç net rezerv' rakamına birebir oturmayabilir]
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
- Phase **2 / 4**: Günlük nowcast + NIR + metric kartlar — ✅ **API kodu tamam; deploy + canlı kabul testi bekliyor**
- Tamamlanan (Faz 1): M-001 (haftalık `fetchSeries`) + M-002 (`computeWeekly`/`weeklyMeta`) +
  M-003 (`GET /api/weekly` + KV cache + CORS + tanımlı hata kodları) + M-004 (haftalık stacked area, tqrlab dark).
- Tamamlanan (Faz 2 — API): M-001 (+günlük A02/A10/USD; generic `fetchSeries`) + M-002 (`computeDailyNowcast`
  nowcast + NIR) + M-003 (`GET /api/summary` → `{weekly, daily, meta}`, `DAILY_TTL` KV cache). `/api/weekly` korundu.
- Doğrulama: `pnpm typecheck` (strict, `any` yok) ✅; `pnpm test` (offline reserve-engine + `/api/summary` mock) ✅;
  `pnpm dry-run` ✅. CI: `.github/workflows/deploy.yml` (check: typecheck/test/dry-run; deploy+smoke main'de;
  Node 22 — tip-sıyırma testleri için; smoke /api/weekly + /api/summary yapısal).
  Kabul testleri offline doğrulandı: nowcast 17/18/19-06 = 164.2/159.4/157.1, NIR_19 ≈ 48.2, çıpa 12-06 = 152.08.
  Canlı EVDS kabul testi → `wrangler secret put TCMB_EVDS_KEY` + `wrangler deploy` ile.
- Faz 2 UI (Part B): tqrlab.com Astro repo'sunda `/tcmb-rezerv-takip` → `/api/summary`'ye geçiş + nowcast kuyruğu + kartlar.
- Dışında (Faz 3): swap (manuel input), `swapHaricNet`, dolarizasyon, cron.
- Blocked by: yok.

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
| M-001 evds-client | `src/evds-client.ts` | ✅ Faz 1-2 (haftalık + günlük; generic) | sonnet |
| M-002 reserve-engine | `src/reserve-engine.ts` | ✅ Faz 1-2 (`computeWeekly`/`weeklyMeta`/`computeDailyNowcast`) | opus |
| M-003 api-worker | `src/index.ts` | ✅ Faz 1-2 (`/api/weekly` + `/api/summary`) | sonnet |
| M-004 dashboard-ui | `ui/src/pages/tcmb-rezerv-takip.astro` + `ui/src/components/reserve/*` | ✅ Faz 1 (haftalık area); Faz 2 UI tqrlab.com repo'sunda | sonnet |
| M-005 scheduled-refresh | `src/scheduled.ts` | not started (Faz 4) | haiku |

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
- ❌ Günlük altın/döviz ayrımı **uydurma** (günlük uluslararası altın fiyatı EVDS'de yok; ayrım haftalık kalır).
- ❌ Fazın ötesine geçme. Faz 1 deploy edilip gözden geçirilmeden Faz 2 kodu yazma (BDUF yok).
- ❌ Jenerik "admin template" görünümü. tqrlab token'ları + DM Sans/JetBrains Mono + sol-kenarlıklı kartlar şart.
