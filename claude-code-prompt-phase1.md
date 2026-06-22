# Claude Code Prompt — Faz 1: Foundation (dikey dilim)

> Bu promptu repo kökünde Claude Code'a ver. `CLAUDE.md` ve `docs/architecture.md` repoda
> olmalı; ayrıca doğrulanmış `tcmb_reserves.py`'yi de repoya koy (referans/kabul testi için).
> **Yalnızca Faz 1'i yap. Bitince dur, deploy talimatını ver, gözden geçirilecek.**

---

## Görev
TCMB rezerv dashboard'unun uçtan uca çalışan en küçük dikey dilimini kur: EVDS3 →
Cloudflare Worker (anahtar secret, KV cache) → Astro + React island → ekranda **haftalık brüt
rezerv stacked area** grafiği, tqrlab dark temasında. Deploy edilebilir olacak.

## Bağlam (önce oku)
1. `CLAUDE.md` — proje, marka token'ları, **EVDS3 endpoint + seri kodları + hesaplama formülleri**, kurallar.
2. `docs/architecture.md` — modüller (M-001..M-004), contract'lar (C-001..C-004), build order.
3. `tcmb_reserves.py` — Python'da doğrulanmış veri katmanı; haftalık çekim/normalize mantığının kaynağı.

## Kapsam — SADECE bunlar (Faz 1)
- **M-001 evds-client** (yalnız haftalık): `fetchSeries(codes, start, end)` — EVDS3'ten ham seri, header'da anahtar, `{tarih,[code]:number|null}[]` normalize. (C-004)
- **M-002 reserve-engine** (yalnız `computeWeekly`): ham `TP.AB.TOPLAM/C2/C1` → `WeeklyPoint[]` (değerler /1000, milyar USD), tarih ISO. (C-002)
- **M-003 api-worker**: `GET /api/weekly?start=dd-mm-yyyy` → `{ weekly: WeeklyPoint[], meta:{...} }`. KV cache (haftalık TTL ~6 sa / 21600 s, env'den), CORS, tanımlı hata kodları. (C-001'in haftalık alt kümesi)
- **M-004 dashboard-ui**: `tcmb-rezerv-takip.astro` + React island `ReserveAreaChart` — Recharts stacked area (Döviz=mavi, Altın=amber, üst çizgi=text), zirve (kırmızı nokta) + güncel (yeşil nokta) işaretli. tqrlab dark tema, %4 grid overlay, DM Sans/JetBrains Mono, footer "tqrlab".

## Dışında bırak (sonraki fazlar — YAPMA)
Günlük nowcast, NIR, dolarizasyon, metric kartlar, swap girişi, cron, light tema. Faz 2-4.

## Adımlar
1. **Repo yapısı (kilitli):** API ayrı **`tcmb-rezerv-api` Worker'ı** (`wrangler.toml → name = "tcmb-rezerv-api"`): `src/types.ts`, `src/evds-client.ts`, `src/reserve-engine.ts`, `src/index.ts`, `wrangler.toml`, `package.json`, `tsconfig.json`. UI ise **mevcut tqrlab.com Astro repo'suna yeni route**: `src/pages/tcmb-rezerv-takip.astro` + `src/components/reserve/ReserveAreaChart.tsx` + token'lar `src/styles/tqrlab.css` (varsa mevcut tqrlab global stiline ekle, yeni dosya açma). Sayfa **public**.
2. **types.ts:** `RawRow`, `WeeklyPoint{tarih,toplam,doviz,altin}`, `WeeklyResponse{weekly,meta}`, `ApiError`. `any` yok.
3. **evds-client.ts:** `fetchSeries`. Endpoint `https://evds3.tcmb.gov.tr/igmevdsms-dis/`, kodlar `-` ile, `type=json`, header `{key}`. content-type json değilse `evds_auth_failed` fırlat. Nokta→alt çizgi eşlemesini hesapla.
4. **reserve-engine.ts:** `computeWeekly(rows)` — `null` toplamları at, ISO tarih, /1000, tarihe göre sırala; ayrıca `weeklyMeta(weekly)` → peak + latest.
5. **index.ts:** Worker fetch handler; `/api/weekly` route; KV oku → miss ise fetch+compute → KV put; CORS header; try/catch → hata kodlu 5xx JSON.
6. **UI:** Astro sayfası Worker'dan `/api/weekly` çeker (build/SSR ya da client island — island basit). `ReserveAreaChart` Recharts `<AreaChart>` stacked; renkler **CSS değişkeninden** okunur (`getComputedStyle` ya da CSS var(--blue) doğrudan fill). tqrlab.css token'ları CLAUDE.md'den.
7. **Doğrulama:** Yerelde `/api/weekly?start=01-10-2025` çağır; 12-06-2026 toplam ≈ **152.08**, baz 27-02-2026 = **210.3/136.8/73.4** gelmeli (kabul testi).

## Yerine getirilecek contract'lar
- **C-004** `fetchSeries(codes,start,end) → RawRow[]` (hatalar: evds_unavailable, evds_auth_failed, non_json_response)
- **C-002** `computeWeekly(rows) → WeeklyPoint[]` (hata: empty_series)
- **C-001 (haftalık alt kümesi)** `GET /api/weekly → {weekly, meta}` (hatalar: evds_unavailable, evds_auth_failed, empty_series, upstream_timeout)

## Tasarım kabul kriterleri (tqrlab)
- Arka plan `--bg` (#060A14), %4 opak grid overlay; panel `--panel`.
- Başlık DM Sans, eksen/sayı JetBrains Mono.
- Stacked area: Döviz `--blue`, Altın `--amber`; toplam çizgisi `--text`; zirve `--red` nokta, güncel `--green` nokta.
- Footer sağ alt küçük harf "tqrlab"; sol alt "Kaynak: TCMB EVDS".
- Hex hardcode YOK — yalnız CSS değişkeni.

## Definition of Done
- [ ] `wrangler dev` ile `/api/weekly` canlı EVDS verisi dönüyor; kabul testi (152.08 / 210.3-136.8-73.4) geçiyor.
- [ ] KV cache çalışıyor (ikinci istek cache'ten); anahtar yalnız secret'ta, hiçbir yanıtta/loglamada görünmüyor.
- [ ] Astro sayfası grafiği tqrlab dark temada render ediyor; hex hardcode yok.
- [ ] `any` yok, TS strict derleniyor; tanımlı hata kodları çalışıyor.
- [ ] Faz 1 dışı hiçbir şey (nowcast/NIR/dolarizasyon/kart) eklenmemiş.
- [ ] README/CLAUDE.md "Current Status" Faz 1 tamam olarak güncellenmiş; deploy adımları yazılı.

## Bitiş
Faz 1 bitince: ne kurduğunu özetle, `wrangler deploy` + `pages deploy` adımlarını ver ve
**Faz 2'ye geçmeden önce gözden geçirme için DUR.** Faz 2 (günlük nowcast + NIR + kartlar)
ayrı promptla gelecek.
