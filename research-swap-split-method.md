# Swap Ayrıştırması + Swap-Hariç Net Rezerv — KESİNLEŞTİRİLMİŞ YÖNTEM

> Doğrulama araştırması — Worker kodu yok. Kaynak: `Rezerv/` klasöründeki **41 günlük analist tablosu**
> (Bürümcekçi-tarzı, 25.03–05.06.2026) + **canlı EVDS** + **public analist yöntemi** ile **üçlü doğrulandı**.
> Tarih: 2026-06-29. Reprodüksiyon betiği: `research-swap-split-backtest.py`.
> Bu doküman önceki `research-swap-nir-reproduction.md`'nin "swap manuel kalmalı" sonucunu **günceller**.

---

## 0. TL;DR — Karar

`Toplam swap (net, stok)` iki bileşene ayrılır ve **biri hariç tamamı EVDS'ten günlük üretilebilir**:

| Bileşen | EVDS'ten? | Formül / kaynak | Eşleşme (41 tablo) |
|---|---|---|---|
| **Yerli banka swapı** | ✅ **EVET — günlük, kesin** | `(TP.SWAPTEKTAR.TOTALSTOKALIMYONLU − …TOTALSTOKSATIMYONLU)/1000` | ort 0,17 / maks **0,33** |
| **Yabancı MB swapı** | ⚠️ **HAYIR — bakımlı sabit** | `16.4` (ikili anlaşma duyurularından; olayda güncellenir) | tüm tarihlerde sabit ✓ |
| **Toplam swap** | ✅ türetilir | `16.4 + yerli_banka(t)` | ort 0,17 / maks **0,28** |
| **Net dış varlık (swap dahil)** | ✅ **kesin** | `(TP.AB.A02 − TP.AB.A11 − TP.AB.A14)/USD/1e6` | ort 0,11 |
| **Net dış varlık (swap hariç)** | ✅ türetilir | `net_dahil − toplam_swap` | ort **0,31** / maks 0,94 |

**Kritik bulgu:** Önceki araştırma `TP.SWAPTEKTAR`'ı **toplam** swap'a (12,9/17,5) karşı test edip "büyüklük
yanlış" diye elemişti. Oysa swap ayrıştırması gösteriyor ki **SWAPTEKTAR net stoku = Yerli banka bacağıdır**;
Yabancı MB ise ~16,4'te **sabit** bir adım fonksiyonudur. İkisi ayrıldığında **swap artık manuel değildir** —
yalnız 16,4 sabiti elle bakım ister.

---

## 1. Kapalı-form yöntem (hepsi milyar USD, günlük iş günü)

```
USD            = TP.DK.USD.A.YTL                                   # alış (gösterge) kuru, TL

# 1) Net dış varlık (swap DAHİL) — bilanço-içi, KESİN
net_dahil(t)   = ( TP.AB.A02 − TP.AB.A11 − TP.AB.A14 ) / USD / 1e6
#   cebirsel özdeş: = NIR + A13,  çünkü A10 = A11 + A12 ve A12 = A13 + A14
#   yani analist standart NIR'a "Kamu/Diğer YP mevduatı (A13)"nı geri ekler

# 2) Yerli banka swapı (TCMB'nin yurt içi bankalarla swap stoku) — KESİN, günlük
yerli_banka(t) = ( TP.SWAPTEKTAR.TOTALSTOKALIMYONLU − TP.SWAPTEKTAR.TOTALSTOKSATIMYONLU ) / 1000
#   işaret: alım yönlü(+) / satım yönlü(−)  →  analistin "Pozitif = alım yönlü swap" notuyla birebir
#   not: TP.SWAPTEKTAR.BISWAPSTOKUSDTUTAR pencere boyunca 0 → TOTALSTOK her şeyi kapsıyor

# 3) Yabancı MB swapı — bakımlı SABİT (adım fonksiyonu)
yabanci_mb     = 16.4    # 2026; yalnız yabancı-MB swap anlaşması olayında güncellenir

# 4) Türetilenler
toplam_swap(t) = yabanci_mb + yerli_banka(t)
net_haric(t)   = net_dahil(t) − toplam_swap(t)
#              = (A02−A11−A14)/USD/1e6 − 16.4 − (TOTALSTOKALIMYONLU − TOTALSTOKSATIMYONLU)/1000
```

Mevcut dashboard serilerine **EK** çekilecek kodlar: `TP.AB.A11`, `TP.AB.A14`,
`TP.SWAPTEKTAR.TOTALSTOKALIMYONLU`, `TP.SWAPTEKTAR.TOTALSTOKSATIMYONLU`. Tek manuel girdi: `yabanci_mb`.

---

## 2. Doğrulama (canlı EVDS'e karşı 40 nokta — `research-swap-split-backtest.py`)

| Test | n | ort \|artık\| | maks |
|---|---|---|---|
| `net_dahil = (A02−A11−A14)/USD` ↔ analist (net_haric+swap) | 33 | 0,11 | — |
| **`Yerli banka` ↔ SWAPTEKTAR net** | 33 | **0,173** | **0,33** |
| **`Toplam swap` ↔ 16.4 + SWAPTEKTAR net** | 33 | **0,167** | **0,28** |
| **`net_haric` (tam yöntem)** | 40 | **0,313** | 0,94 |
| Kabul: \|Δnet_haric\| ≤ 0,5 | 40 | — | **31/40 geçer** |

**Spot teyitler:**
- 27-02 satım-stok 3416,8 M$ → yb −3,42 (analist baz −3,5) ·
- **04-06: alım 13517 − satım 1803 → +11,71 (analist 11,7 — birebir)** ·
- 05-15 → −1,64 (analist −1,7) · 06-04: net_dahil 48,5 = analist (30,7+17,8=48,5 birebir).

**Erken-dönem offset (dürüstlük):** Kabul eşiğini aşan 9 noktanın **tamamı 08.04 öncesidir** ve tutarlı bir
**+0,5…+0,9 sapma** taşır. Bu sapma **swap tarafında değil net_dahil tarafındadır**: 04-06'da swap birebir
tutarken (Δ=0,0) net_dahil ~+1,0 yüksektir → analistin **eski tablo formatındaki** net dış varlık tabanı
(muhtemelen farklı gün/kur hizalaması) kaynaklı, yöntem hatası değil. **08.04'ten 04.06'ya kadar 31 ardışık
noktanın hepsi ±0,5 içinde** (çoğu ±0,3). Asıl teslim olan **swap ayrıştırması erken dönemde bile kesindir.**

Tam 40-satır artık tablosu için: `python3 research-swap-split-backtest.py` (anahtar `.dev.vars`'tan).

---

## 3. EVDS seri kataloğu (doğrudan teyit edildi, anahtar header'da)

| Kod | Ad | Frekans | Birim | Rol |
|---|---|---|---|---|
| `TP.AB.A02` | Dış Varlıklar | iş günü | bin TL | net_dahil tabanı |
| `TP.AB.A11` | Yurt dışı yerleşiklere yükümlülük | iş günü | bin TL | net_dahil'den düşülür |
| `TP.AB.A14` | Bankacılık sektörü YP mevduatı | iş günü | bin TL | net_dahil'den düşülür |
| `TP.AB.A13` | Kamu/Diğer YP mevduatı | iş günü | bin TL | (NIR'a göre geri eklenen) |
| `TP.DK.USD.A.YTL` | USD alış | iş günü | TL | TL→USD çevrim |
| `TP.SWAPTEKTAR.TOTALSTOKALIMYONLU` | TOPLAM swap stok (alım yönlü) | **günlük** | milyon USD | yerli_banka (+) |
| `TP.SWAPTEKTAR.TOTALSTOKSATIMYONLU` | TOPLAM swap stok (satım yönlü) | **günlük** | milyon USD | yerli_banka (−) |
| `TP.SWAPTEKTAR.BISWAPSTOKUSDTUTAR` | BIST swap stok | günlük | milyon USD | 2026'da 0 → kullanılmaz |
| `TP.DOVVARNC.K18` | "Merkez Bankalarıyla Swap" (yabancı-MB) | **aylık** | — | 16,4 sabitinin aylık çapraz-kontrolü (forward-bacak; birebir oturmayabilir) — *teyit edilecek* |

Datagroup keşfi: `…/igmevdsms-dis/serieList/code=bie_swaptektarf&type=json` (path-stili, anahtar header'da).

---

## 4. `Yabancı MB = 16,4` neden ve bakım kuralı

TCMB **yabancı-MB swap stokunu tek satır olarak yayımlamaz**; analistler ikili anlaşma duyurularından kurar
(forward bacağı toplam swap'ın içinde, IMF SDDS Tablo II'de görünür ama ayrışmaz). Bileşenler (anlaşma tavanları):

| Karşı taraf | Para | Tavan (≈USD) | Önemli tarihler | 2026 durumu |
|---|---|---|---|---|
| Katar (QCB) | TRY/QAR | ~15 | 2018→2020 ($15bn'e); uzatma 2021 | en büyük bacak, büyük ölçüde çekili |
| Çin (PBoC) | TRY/CNY | RMB35 ≈ 5,5 | 2019; tam çekim $5,49bn (15.06.2021); **yenileme 06-2025** | aktif |
| BAE (CBUAE) | TRY/AED | AED18 ≈ 5 | 2022; **yenileme/yeniden boyut 10-2025** (TRY bacağı 64→198 mlr) | aktif |
| Kore (BoK) | TRY/KRW | KRW2,3tn ≈ 2 | 2021; **yenileme 08-2024** (Ağu-2027'ye) | çekilmemiş ~ $0 |

- **Adım fonksiyonu:** stok yalnız anlaşma olayında (imza/uzatma/çekim/geri ödeme) değişir → olaylar arası
  sabit tutmak doğru şekildir. Pencere boyunca (03–06.2026) bir olay yok → 16,4 sabit tutuluyor ve 41 tablonun
  hepsinde 16,4 görünüyor (Bürümcekçi 12.06.2026: **16,3**, %11,8'i SDR-dışı → birebir tutarlı).
- **16,4 bir TAHMİNDİR**, yayımlanmış resmi rakam değil; yerel-para bacaklı olduğu için USD-karşılığı kurla
  hafif kayar. **Bakım kuralı:** yeni TCMB ikili-swap duyurusunda (ya da `TP.DOVVARNC.K18` aylık değeri belirgin
  saparsa) sabiti güncelle. Aksi halde dokunma.

---

## 5. Public analist yöntemiyle çapraz-kontrol

- **Çekirdek formül birebir doğrulandı** (Mahfi Eğilmez, Malumatfuruş, QNB, Özcan Kuzulu):
  `Net Rezerv = (Dış Varlıklar − Döviz Yük.)/USD`, `Swap Hariç = Net − Swap`.
- **Bürümcekçi/QNB** yabancı-MB swap toplamını ayrı verir (12.06.2026: **16,3**); yerli banka swapını "nette
  +0,4 mlr alım yönlü" tanımlar → bu çalışmanın bulgusuyla aynı.
- **Enver Erkan / Tera** aynı analitik-bilanço yöntemini haftalık yayımlar; ayrı swap ayrıştırması bulunmadı.
- **Uyarı (kanonik değil):** "swap hariç net rezerv"in resmi tanımı yoktur (Şalom: "formülü yok"); yerli-banka
  swapını düşmenin doğruluğu bile tartışmalı. Üçüncü taraf rakamlarıyla ±birkaç mlr fark olağandır → UI'da caveat.

**Kaynaklar:** Mahfi Eğilmez (mahfiegilmez.com — "Rezerv Meselesi" / "Rezervleri Hesaplama Rehberi"); Malumatfuruş
(malumatfurus.org/merkez-bankasi-doviz-rezervi); Özcan Kuzulu (ozcankuzulu.com/tcmb-rezervleri-ve-swap-gercegi);
QNB Invest (investodak); Ekonomim ("İdeal rezerve…" 12.06.2026 Bürümcekçi; "Yurtiçi swaplar eridi"); Paraanaliz
("Swap Dopingi"); Şalom ("Swap hariç net rezerv yoktur"); TCMB Basın Duyuruları (Katar ANO2018-33/2020-29, Çin
ANO2021-24 + PBoC 06-2025, BAE ANO2022-04/2025-52, Kore ANO2021-34/2024-43); AA ("28 milyar dolar"); CFR/MEE
(~19 mlr yabancı-MB swap, 2023); IMF SDDS IRFCL şablonu (Tablo II — swapların forward bacağı).

---

## 6. Önceki araştırmaya düzeltme

`research-swap-nir-reproduction.md` §1b/§2 "swap stoku için kapalı form yok; SWAPTEKTAR büyüklük yanlış,
manuel kalsın" diyordu. **Düzeltme:** o değerlendirme `SWAPTEKTAR`'ı **toplam** swap'a karşı yaptığı için yanıltıcıydı.
Swap ayrıştırması (`Rezerv/` 41 tablo) ortaya koyuyor ki `SWAPTEKTAR` net stoku **Yerli banka** bacağına ±0,33 oturur;
Yabancı MB ~16,4 sabittir. Dolayısıyla **swap-hariç net** artık (16,4 sabiti dışında) **günlük otomatik** üretilir;
SDDS `TP.DOVVARNC.K15` (aylık, ~3 mlr yüksek) yalnızca ikincil bilgi çizgisi olarak kalır.
