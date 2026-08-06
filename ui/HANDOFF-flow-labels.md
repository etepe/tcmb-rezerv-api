# HANDOFF — akış panellerinde dönem etiketi/aralığı (tqrlab.com repo)

**Bağlam:** API tarafında mail (`src/email.ts`) düzeltildi; aynı düzeltme UI'da da gerekiyor.
**Hesaplama DEĞİŞMEDİ** — yalnızca etiket ve dönem aralığı dürüstleşiyor. API sözleşmesi de
değişmedi (yeni alan yok); UI gerekli her şeyi `prevTarih`/`tarih`'ten türetebilir.

## Kök neden — TCMB yayım takvimi

Resmi haftalık brüt rezerv (`TP.AB.TOPLAM`) **Perşembe 14:30 TRT**'de, bir **önceki Cuma**ya
ait olarak yayımlanır. Yani son resmi Cuma ("çıpa") **6-12 gün** geride olabilir:

| An | Son resmi Cuma | Çıpa yaşı |
|---|---|---|
| Perşembe 14:30 sonrası → Çarşamba | önceki Cuma | 6-11 gün |
| Perşembe 14:30 **öncesi** | iki hafta önceki Cuma | 12 gün |

Doğrulama (06-08-2026, 09:08 TRT, cache'siz canlı çekim): `latestWeekly = 2026-07-24`,
`latestDaily = 2026-08-04` → 31 Tem verisi henüz yayımlanmamıştı. Bu bir hata değil, takvimin
sonucu.

## Bunun UI'da yarattığı üç görünüm

1. **"Rezerv akışı" (günlük barlar)** — günlük seri `[çıpa, bugün]` aralığında çekildiği için
   bar sayısı **5 ↔ 10 iş günü** arasında salınır (06-08 sabahı: 7 bar, 27 Tem → 4 Ağu).
   Panel bunu "son N gün" gibi sunmamalı.
2. **Haftalık değişim — devam eden bar** — tabanı son resmi Cuma olduğu için 8-12 gün
   sürebilir; "hafta" demek yanıltıcı (06-08: 24 Tem → 4 Ağu = **11 gün**).
3. **Aylık değişim — devam eden bar** — ayın ilk günlerinde o ayda henüz yayımlanmış Cuma
   olmadığından `computeMonthlyFlow`'un son ay temsilcisi bir ay geride kalır ve bar **iki ayı
   birden** kapsar (06-08: 26 Haz → 4 Ağu = **39 gün**, `ay` alanı ise `"2026-07"`).
   ⚠️ Son bar için `ay` alanına GÜVENME — X ekseni etiketini `prevTarih`/`tarih`'ten üret.

## Yapılacak (mail ile birebir aynı kural)

Devam eden (`nowcast: true`) barların etiketinde/tooltip'inde **dönemin gerçek uzunluğunu**
göster ve gerektiğinde başlığı değiştir:

```ts
const days = daysBetween(p.prevTarih, p.tarih);          // takvim günü

// Haftalık (WeeklyChangeBars)
const label = days > 7 ? "Son resmi haftadan bu yana" : "Hafta içi kümüle";

// Aylık (MonthlyChangeBars): "ay içi kümüle" ancak İKİSİ birden sağlanırsa
//   (a) taban, bitiş ayının hemen önceki ayında  (monthsBetween === 1)
//   (b) taban, ait olduğu ayın son Cuma'sına yakın (lastFridayDom − gün < 5)
const label = clean ? "Ay içi kümüle" : "Son resmi ay sonundan bu yana";
```

Tooltip/alt not biçimi (mailde kullanılan): `24 Tem → 04 Ağu, 11 gün, nowcast`.

Çıpa 7 günden eskiyse panel altına açıklama satırı ekle:

> Resmi haftalık baskı, önceki Cuma'ya ait olarak Perşembe 14:30 TRT'de yayımlanır; elde en
> güncel {çıpa} olduğu için yukarıdaki aralıklar bir hafta değil {N} gün kapsar.

Günlük "Rezerv akışı" paneli için de aralık açıkça yazılsın:
`Son resmi Cuma'dan (24 Tem) bugüne: 7 iş günü`.

## Referans uygulama

`src/email.ts` içindeki `daysBetween` / `lastFridayDom` / `monthsBetween` / `isCleanMonthToDate`
saf yardımcılarıdır; TS olarak doğrudan taşınabilir. Testler: `test/email.test.ts` →
"resmi Cuma baskısı gecikmeli…" ve "devam eden ay barı iki ayı kapsıyorsa…".

## Kapsam dışı (bilinçli karar)

Nowcast ile **sanal Cuma/ay-sonu üretilmeyecek** (kullanıcı kararı, 06-08-2026): barların
tabanı resmi baskı olarak kalır; yalnız etiket dürüstleşir. Resmi veri yayımlandığında barlar
kendiliğinden normal hafta/ay uzunluğuna döner.
