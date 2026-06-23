# UI drop-in — `tcmb-rezerv-takip` (tqrlab.com Astro repo)

Bu klasör **bu repoda build edilmez.** Dosyalar mevcut **tqrlab.com Astro repo**'suna
(`/yz-model-takip` deseni) kopyalanır. Faz 1 kapsamı: yalnız haftalık stacked area.

## Kopyalanacak dosyalar

| Bu repo | tqrlab.com Astro repo |
|---|---|
| `ui/src/pages/tcmb-rezerv-takip.astro` | `src/pages/tcmb-rezerv-takip.astro` |
| `ui/src/components/reserve/ReserveAreaChart.tsx` | `src/components/reserve/ReserveAreaChart.tsx` |
| `ui/src/styles/tqrlab.css` | mevcut global tqrlab stiline **token'ları ekle** (yeni dosya açma) |
| `ui/.env.example` | `.env.example`'a `PUBLIC_REZERV_API_BASE` satırını ekle |

## Gereken bağımlılıklar (Astro repo'da)

```bash
pnpm add recharts
pnpm add -D @astrojs/react react react-dom @types/react @types/react-dom
```

`astro.config` içinde React entegrasyonu ekli olmalı:

```js
import react from "@astrojs/react";
export default defineConfig({ integrations: [react()] });
```

## Yapılandırma

Worker tabanını env ile geç (deploy edilmiş Worker URL'i). Astro'da
`import.meta.env.PUBLIC_REZERV_API_BASE` ile okunur:

```bash
# .env (Astro) — bkz. ui/.env.example
PUBLIC_REZERV_API_BASE="https://tcmb-rezerv-api.<hesap>.workers.dev"
```

Cloudflare Pages'te aynı değişkeni **build/runtime env var** olarak da tanımla.
Sayfa **public**'tir (Cloudflare Access gating yok). Grafik client island olarak
(`client:load`) Worker'ın `/api/weekly?start=01-10-2025` ucundan veri çeker.

## Tasarım notları
- Renkler **yalnız** CSS değişkeninden (`--blue`/`--amber`/`--text`/`--red`/`--green`).
  Bileşende hex hardcode yok.
- Başlık **DM Sans**, eksen/sayı **JetBrains Mono**.
- Arka plan `--bg`, %4 opak grid overlay (`.tqr-grid-overlay`), panel `--panel`.
- Footer sağ alt küçük harf **tqrlab**; sol alt **Kaynak: TCMB EVDS**.
