# tcmb-rezerv-api

TCMB uluslararası rezerv dashboard'unun **Cloudflare Worker API**'si (tqrlab).
EVDS3'ten haftalık brüt rezervi çeker, hesaplar, KV'de cache'ler ve JSON sunar.
EVDS anahtarı **Worker secret**'tadır; tarayıcıya/repoya/URL'e asla gitmez.

> **Faz 4 / 4**. Kapsam: haftalık brüt rezerv (`/api/weekly`) **+ günlük nowcast + NIR**
> + **dolarizasyon** (`/api/summary`) **+ cron ön-ısıtma** (KV cache warm). Swap manuel input UI tarafında.

## Mimari (Faz 1 dilimi)

```
EVDS3 → evds-client (M-001) → reserve-engine (M-002) → api-worker (M-003) ↔ KV → dashboard-ui (M-004)
```

| Modül | Dosya | Sorumluluk |
|---|---|---|
| M-001 evds-client | `src/evds-client.ts` | EVDS3 ham seri çek + normalize (tek dış temas; haftalık + günlük) |
| M-002 reserve-engine | `src/reserve-engine.ts` | `computeWeekly` + `weeklyMeta` + `computeDailyNowcast` + `computeDolarizasyon` (saf) |
| M-003 api-worker | `src/index.ts` (+ `src/summary.ts`) | `GET /api/weekly`, `GET /api/summary`, KV cache, CORS, hata kodları. `summary.ts` = paylaşılan fetch+compute+cache (HTTP + cron aynı yol) |
| M-004 dashboard-ui | `ui/` (Astro repo'ya drop-in) | Haftalık stacked area + günlük nowcast kuyruğu + dolarizasyon + kartlar (tqrlab dark) |
| M-005 scheduled-refresh | `src/scheduled.ts` | Cron Trigger → KV ön-ısıtma (`summary` + `weekly` anahtarı); public sözleşmeyi değiştirmez |

## API

### `GET /api/weekly?start=dd-mm-yyyy&end=dd-mm-yyyy`
- `start` opsiyonel (varsayılan `DEFAULT_WEEKLY_START`), `end` opsiyonel (bugün).
- Yanıt: `{ weekly: WeeklyPoint[], meta }` — değerler **milyar USD**.

```json
{
  "weekly": [{ "tarih": "2026-06-12", "toplam": 152.08, "doviz": 80.0, "altin": 72.08 }],
  "meta": {
    "peak": { "tarih": "2026-02-27", "toplam": 210.3 },
    "latest": { "tarih": "2026-06-12", "toplam": 152.08, "doviz": 80.0, "altin": 72.08 },
    "count": 1, "start": "01-10-2025", "end": "12-06-2026",
    "updatedAt": "2026-06-22T...Z", "unit": "milyar USD", "source": "TCMB EVDS", "cached": false
  }
}
```

### `GET /api/summary?weeklyStart=dd-mm-yyyy&end=dd-mm-yyyy`
- Haftalık + **günlük nowcast + NIR** birlikte. `weeklyStart`/`end` opsiyonel.
- Çıpa = aralıktaki son resmi haftalık `toplam`; günlük seri çıpadan bugüne çekilir.
- Yanıt: `{ weekly: WeeklyPoint[], daily: DailyPoint[], dolarizasyon: DolarPoint[], meta }` — değerler **milyar USD**.
  `daily[i]` = `{ tarih, brutRezerv, nir }`; `dolarizasyon[i]` = `{ tarih, ypToplam, ypYurtici }`
  (haftalık YP mevduat; **soft-fail** → EVDS hatasında `[]`). Swap **manuel input** UI tarafında (API'de yok).

```json
{
  "weekly": [{ "tarih": "2026-06-12", "toplam": 152.08, "doviz": 80.0, "altin": 72.08 }],
  "daily":  [{ "tarih": "2026-06-19", "brutRezerv": 157.1, "nir": 48.2 }],
  "meta": {
    "anchorDate": "2026-06-12", "anchorBrut": 152.08,
    "peak": { "tarih": "2026-02-27", "toplam": 210.3 },
    "latestWeekly": "2026-06-12", "latestDaily": "2026-06-19",
    "updatedAt": "2026-06-22T...Z", "unit": "milyar USD", "source": "TCMB EVDS", "cached": false
  }
}
```

Hata: `5xx` + `{ "error": <kod>, "message": ... }`.
Kodlar: `evds_unavailable`, `evds_auth_failed`, `non_json_response`, `empty_series`,
`upstream_timeout`, `no_anchor`, `anchor_not_in_daily`, `bad_request`, `not_found`, `internal_error`.

## Geliştirme

```bash
pnpm install
pnpm typecheck          # tsc --noEmit (strict, any yok)
pnpm test               # offline birim testi (reserve-engine; ağ/secret gerekmez)
```

## Deploy

```bash
# 1) EVDS anahtarını secret olarak gir (interaktif; asla repoya yazma)
wrangler secret put TCMB_EVDS_KEY

# 2) KV namespace oluştur ve id'yi wrangler.toml'a yaz
wrangler kv namespace create REZERV_CACHE
#   → çıktıdaki id'yi wrangler.toml [[kv_namespaces]] id alanına koy
#   → wrangler dev için isteğe bağlı: wrangler kv namespace create REZERV_CACHE --preview

# 3) Yerel çalıştır (secret için `.dev.vars` içine TCMB_EVDS_KEY=... yazılabilir)
wrangler dev
#   → GET http://localhost:8787/api/weekly?start=01-10-2025

# 4) Yayınla
wrangler deploy
```

### Kabul testi (canlı veri, secret gerekli)
`/api/weekly?start=01-10-2025` çağır:
- `12-06-2026` toplam ≈ **152.08**
- baz `27-02-2026` = **210.3 / 136.8 / 73.4** (toplam / altın / döviz)
- İkinci istek **cache**'ten gelir (`meta.cached = true`).

`/api/summary?weeklyStart=01-10-2025` çağır (nowcast):
- çıpa `12-06-2026` = **152.08**; nowcast `17/18/19-06` = **164.2 / 159.4 / 157.1** (±0,1)
- `daily` son noktada `nir` dolu (`19-06` ≈ **48.2**).

## Yapılandırma (`wrangler.toml`)
- `WEEKLY_TTL` (sn, varsayılan `21600` ≈ 6 sa) — `/api/weekly` KV cache TTL'i.
- `DAILY_TTL` (sn, varsayılan `3600` ≈ 1 sa) — `/api/summary` KV cache TTL'i (günlük daha sık tazelenir).
- `DEFAULT_WEEKLY_START` (`dd-mm-yyyy`) — `start`/`weeklyStart` verilmezse kullanılır.
- `TCMB_EVDS_KEY` **secret** (toml'da DEĞİL).

## Cron ön-ısıtma (Faz 4 · M-005)
`wrangler.toml → [triggers].crons` ile Worker periyodik olarak `scheduled()` handler'ını
çalıştırır (`src/scheduled.ts → warmCache`). Handler, UI'nin (ve CI smoke'unun) düştüğü
KV anahtarlarını tazeler: `summary:{DEFAULT_WEEKLY_START}:{bugün}` **ve** `weekly:…`.
Böylece kullanıcı (ve deploy sonrası smoke) hep **sıcak cache**'e düşer; "bayat cache" kaynaklı
smoke hatası sınıfı kapanır. Fetch+compute mantığı HTTP handler ile **aynı** `buildSummary`/
`buildWeekly` (src/summary.ts) — kopya yok. **Public API sözleşmesi değişmez; cron yalnız cache ısıtır.**

Tetikler (UTC; TR = UTC+3) — mütevazı sıklık, EVDS dövülmez (~16 tetik/hafta):
- `0 8,12,16 * * 1-5` — hafta içi 11/15/19 TR (analitik bilanço / iş günü A02·A10·USD).
- `0 17 * * 5` — Cuma 20 TR (haftalık brüt rezerv yayımı).

Deploy sonrası tetikler Cloudflare dashboard (Workers → tcmb-rezerv-api → Triggers) veya
`wrangler deployments` ile doğrulanır. Hatalar `warmCache` içinde yutulur (cron handler asla fırlatmaz).

## UI
`ui/` klasörü tqrlab.com Astro repo'suna drop-in'dir; bkz. `ui/README.md`.
