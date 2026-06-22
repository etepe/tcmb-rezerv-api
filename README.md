# tcmb-rezerv-api

TCMB uluslararası rezerv dashboard'unun **Cloudflare Worker API**'si (tqrlab).
EVDS3'ten haftalık brüt rezervi çeker, hesaplar, KV'de cache'ler ve JSON sunar.
EVDS anahtarı **Worker secret**'tadır; tarayıcıya/repoya/URL'e asla gitmez.

> **Faz 1 / 4** (Foundation). Kapsam: yalnız **haftalık** brüt rezerv (`/api/weekly`).
> Günlük nowcast / NIR / dolarizasyon / cron sonraki fazlar.

## Mimari (Faz 1 dilimi)

```
EVDS3 → evds-client (M-001) → reserve-engine (M-002) → api-worker (M-003) ↔ KV → dashboard-ui (M-004)
```

| Modül | Dosya | Sorumluluk |
|---|---|---|
| M-001 evds-client | `src/evds-client.ts` | EVDS3 ham seri çek + normalize (tek dış temas) |
| M-002 reserve-engine | `src/reserve-engine.ts` | `computeWeekly` + `weeklyMeta` (saf) |
| M-003 api-worker | `src/index.ts` | `GET /api/weekly`, KV cache, CORS, hata kodları |
| M-004 dashboard-ui | `ui/` (Astro repo'ya drop-in) | Haftalık stacked area (tqrlab dark) |

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

Hata: `5xx` + `{ "error": <kod>, "message": ... }`.
Kodlar: `evds_unavailable`, `evds_auth_failed`, `non_json_response`, `empty_series`,
`upstream_timeout`, `bad_request`, `not_found`, `internal_error`.

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

## Yapılandırma (`wrangler.toml`)
- `WEEKLY_TTL` (sn, varsayılan `21600` ≈ 6 sa) — haftalık KV cache TTL'i.
- `DEFAULT_WEEKLY_START` (`dd-mm-yyyy`) — `start` verilmezse kullanılır.
- `TCMB_EVDS_KEY` **secret** (toml'da DEĞİL).

## UI
`ui/` klasörü tqrlab.com Astro repo'suna drop-in'dir; bkz. `ui/README.md`.
