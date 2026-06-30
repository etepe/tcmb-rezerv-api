# Araştırma — Günlük altın-fiyat değerleme etkisi (Faz 6)

**Tarih:** 2026-06-30 · **Durum:** doğrulandı → API'ye kodlandı (`computeGoldPriceEffect`, `gold-client.ts`).

## Soru
Günlük "Rezerv akışı" barları `brutRezerv`'in günlük farkı = `Δ(A02/USD)` olup **dört etkiyi
karıştırıyor**: (1) FX alım/satım (müdahale), (2) **altın fiyatı değerlemesi**, (3) FX paritesi
(EUR/USD vb.), (4) yükümlülük değişimleri. Altın TCMB rezervinin büyük kısmı olduğundan, "TCMB ne
kadar döviz aldı/sattı?" sorusu altın fiyatı gürültüsüyle bulanıklaşıyor. **Altın fiyat etkisini
ayrıştırıp** barları "altın fiyat etkisi" vs "diğer (döviz akışı + parite)" olarak göstermek hedef.

## Yöntem (oran-bazlı; miktar kısa pencerede sabit)
```
anchorAltin  = weekly[son].altin            # C1, milyar USD (resmi haftalık, market-değerli)
etki_kum(t)  = anchorAltin × ( altınFiyatı(t) / altınFiyatı(çıpa) − 1 )    # çıpadan beri kümülatif, mlr USD
günlük katkı = etki_kum(t_i) − etki_kum(t_{i-1})
diğer        = Δbrut − günlük altın katkısı   # döviz akışı + FX paritesi + yükümlülük (saf müdahale DEĞİL)
```
- **Oran-bazlı** olduğundan altın fiyatı serisinin mutlak seviyesi/baz farkı sadeleşir → altın
  **vadeli** (GC=F) ≈ spot kullanılabilir. Çıpa her yeni Cuma'da resmi C1'e sıfırlanır.
- **Miktar sabit** varsayımı yalnız çıpa→bugün (~5 iş günü) penceresinde gereklidir.

## Veri / doğrulama (canlı `/api/summary` haftalık C1 + Yahoo GC=F günlük, Eki 2025–Haz 2026)
1. **Altın rezervin ~%62'si** (2026-06-19: 97,7 / 157,2 mlr USD) → fiyat oynaklığı barları ciddi şişiriyor.
2. **İma edilen miktar (C1/fiyat) kısa pencerede sabit:** 38 hafta ort **25,1M ons** (~780 ton), CV %5,9.
   Eki–Mar ~26M ons; **Mart sonu ~130 tonluk GERÇEK altın satışı** sonrası ~23M ons'a iner (altın *değeri*
   −%13 düşerken *fiyat* yalnız −%9 → miktar değişimi, fiyat değil). Tek hafta içinde miktar ~sabit → yöntem geçerli.
3. **Haftalık %Δaltın_değeri vs %Δaltın_fiyatı korelasyonu = 0,68** (Mart miktar şoku dâhil; o hariç daha yüksek).
4. **A02 günlük altın değerlemesi içeriyor (dolaylı kanıt):** nowcast resmi haftalık `toplam`'a (C1+C2,
   market-değerli) ±0,03 oturuyor; altın %62 ve hafta içi oynakken bu doğruluk ancak ΔA02 altın fiyat
   hareketini taşıyorsa mümkün. Son hafta (06-19→06-26) büyüklük tutarlı: −8,2 mlr düşüşün ~−3,4'ü altın
   fiyatı (06-26'da 4079 vs çıpa 4224), kalan ~−4,9 döviz/diğer.

## Karar
- **Kaynak:** EVDS'te temiz günlük uluslararası altın fiyatı YOK (CLAUDE.md ile uyumlu) → **HARİCİ** kaynak
  (Yahoo GC=F) `src/gold-client.ts`'te izole edildi. Bu, "EVDS-only" kuralına bilinçli, dar bir istisnadır;
  **soft-fail**: çekilemezse `goldPriceEffect: null` + `meta.goldPriceSource: "unavailable"`, çekirdek nowcast düşmez.
- **API:** `DailyPoint.goldPriceEffect` (çıpadan beri kümülatif) + `meta.goldPriceSource`. `computeGoldPriceEffect`
  (saf) + `gold-client.fetchGoldUsdByDate` (harici fetch). Public sözleşme yalnız **eklenir**.

## Caveat (KORUNUR)
- "Diğer" segmenti **saf müdahale değildir** — FX paritesi (EUR/USD/altın-dışı değerleme) + yükümlülük
  içerir; TCMB resmî müdahale verisi yayımlamaz.
- Altın etkisi **miktar sabit** varsayar; gerçek altın alım/satımı (ör. Mart ~130 ton) çıpa C1'e zaten
  yansıdığından kısa pencerede sapma küçüktür, ama çıpa haftasında büyük bir altın işlemi olursa bir miktar atfedilebilir.
- Altın fiyatı vadeli (GC=F) proxy'dir; oran-bazlı kullanım baz farkını büyük ölçüde sadeleştirir.
