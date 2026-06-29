# UI HANDOFF — Otomatik swap / swap-hariç net rezerv (manuel girdiyi kaldır)

> Hedef: tqrlab.com Astro repo'sundaki `tcmb-rezerv-takip` sayfasında **manuel swap girdisini KALDIR**
> ve `/api/summary`'nin yeni **otomatik `swap`** verisini tüket. Worker tarafı (Faz 5) **CANLI** — bu doküman
> yalnız UI değişikliğini tarifler. Mobil/sonraki oturum için kendine yeten brief.

## 1. Ne değişti (Worker / API — TAMAM, deploy edildi)
`GET /api/summary` artık iki yeni alan döner:

```jsonc
{
  "weekly":[...], "daily":[...], "dolarizasyon":[...],
  "swap": [
    // günlük (çıpa→bugün penceresi), milyar USD
    { "tarih":"2026-06-26", "netDahil":47.3, "yabanciMb":16.36,
      "yerliBanka":-2.12, "toplamSwap":14.24, "netHaric":33.1 }
  ],
  "meta": {
    "...": "...",
    "swapMbSource": "evds:K18",   // "evds:K18" | "fallback"
    "swapMb": 16.36               // hesapta kullanılan Yabancı MB (mlr USD)
  }
}
```

`SwapPoint` alanları (hepsi `number`, `tarih` ISO `yyyy-mm-dd`):
| alan | anlam |
|---|---|
| `netDahil` | Net dış varlık (swap **dahil**) = (A02−A11−A14)/USD |
| `yabanciMb` | Yabancı MB swapı (aylık adım; \|DOVVARNC.K18\|/1000) |
| `yerliBanka` | Yerli banka swapı (SWAPTEKTAR net; +alım / −satım) |
| `toplamSwap` | `yabanciMb + yerliBanka` |
| `netHaric` | Net dış varlık (swap **hariç**) = `netDahil − toplamSwap` |

- `swap` boş dizi (`[]`) gelebilir (EVDS soft-fail) → UI bu durumda swap kartını "veri yok" durumuna düşürmeli, çökmemeli.
- "En güncel" değerler için `swap[swap.length-1]` kullan. Zaman serisi grafiği için tüm diziyi kullan.

## 2. UI'da yapılacaklar (tqrlab.com repo)
Bileşenler (CLAUDE.md Module Map): `src/components/reserve/SwapCard.tsx`, `ReserveDashboard.tsx`,
`MetricCards.tsx`, sayfa `src/pages/tcmb-rezerv-takip.astro`, stil `tqrlab.css`.

1. **Manuel girdiyi KALDIR:** swap `<input>` alanı + `?swap=` query parse + `localStorage` swap okuma/yazma
   tamamen silinecek. Paylaşım linki üretiminden `&swap=` parametresi çıkacak (`?theme`/`?print` KALIR).
2. **API'den tüket:** `ReserveDashboard` zaten `/api/summary` çekiyor → `data.swap` ve `data.meta.swapMb*`'ı
   `SwapCard`'a geçir. (Ek fetch yok.)
3. **SwapCard içeriği (öneri):** sol-kenarlıklı metric kartı —
   - Başlık: **Net Dış Varlık (swap hariç)** = `netHaric` (en güncel), büyük rakam, JetBrains Mono.
   - Alt satır kırılım: `Toplam swap` = `toplamSwap`; ` ├ Yabancı MB` = `yabanciMb`; ` └ Yerli banka` = `yerliBanka`.
   - İkincil: `Net dış varlık (swap dahil)` = `netDahil`.
   - Kenarlık rengi: net_haric artışta `--green`, azalışta `--red`, nötr `--blue` (mevcut MetricCard deseni).
4. **Caveat metni KORUNUR** (küçük, `--muted`): *"'Swap hariç net rezerv' kanonik bir tanım değildir; kullanılan
   swap bileşenlerine göre üçüncü taraf rakamlarıyla farklılaşabilir. Yabancı MB swapı aylık (TCMB SDDS) tahmindir."*
5. **Kaynak rozeti (opsiyonel):** `meta.swapMbSource === "fallback"` ise küçük bir "MB tahmini (sabit)" etiketi
   göster; `"evds:K18"` ise gizle.

## 3. Marka / tasarım token'ları (hardcode YOK — CSS değişkeni)
`--bg #060A14 · --panel #0C1322 · --grid #1B2436 · --text #C9D4E5 · --muted #5B6B86 ·
--blue #58A6FF · --green #3FB950 · --amber #D29922 · --red #F85149`.
Başlık **DM Sans**, veri/sayı **JetBrains Mono**. Sol-kenarlıklı kartlar. Footer küçük harf **tqrlab**.
Sayı formatı TR (binlik nokta, ondalık virgül) gösterimde; veri katmanı nokta-ondalık `number`.

## 4. Kabul kriterleri
- [ ] Sayfada hiçbir manuel swap input / `?swap=` / localStorage izi yok.
- [ ] SwapCard `/api/summary`'nin `swap`'ından net_haric + Yabancı MB/Yerli banka/Toplam gösteriyor.
- [ ] `swap: []` (soft-fail) durumunda kart "veri yok"a düşüyor, sayfa çökmüyor.
- [ ] Caveat metni + tqrlab tokenları + DM Sans/JetBrains Mono + sol-kenar accent korunmuş.
- [ ] Paylaşım linki & PDF (`?theme=light&print=1`) bozulmadı; link'te `swap=` yok.
- [ ] `astro build` + `astro check` temiz.

## 5. Referans
- Yöntem + doğrulama: `research-swap-split-method.md` (41 analist tablosu, ort artık ~0,3 mlr).
- API tipleri: `src/types.ts` (`SwapPoint`, `SummaryResponse.swap`, `SummaryMeta.swapMbSource/swapMb`).
- Backtest: `research-swap-split-backtest.py`.
- Worker base URL (env `PUBLIC_TCMB_API_BASE`): `https://tcmb-rezerv-api.<hesap>.workers.dev`.
