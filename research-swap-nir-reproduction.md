# Ampirik Reprodüksiyon: Swap Stoku + Net Dış Varlık (EVDS)

> ⚠️ **GÜNCELLEME (2026-06-29) — bu dokümanın "swap manuel kalmalı" sonucu AŞILDI.**
> 41 günlük analist tablosu (`Rezerv/`) swap'ı **Yabancı MB + Yerli banka** olarak ayrıştırınca görüldü ki
> aşağıda §1b/§2'de elenen `TP.SWAPTEKTAR` aslında **Yerli banka** bacağıdır (toplam swap'a değil, bileşene
> bakılmalıydı): `yerli_banka = (TP.SWAPTEKTAR.TOTALSTOKALIMYONLU − …SATIMYONLU)/1000`, günlük, artık ≤0,33 mlr.
> Yabancı MB ≈ 16,4 sabittir. Böylece **swap-hariç net artık (16,4 sabiti dışında) günlük otomatik** üretilir.
> Kesin yöntem + 40-nokta doğrulama: **`research-swap-split-method.md`** (+ `research-swap-split-backtest.py`).
> Aşağıdaki net-dahil `(A02−A11−A14)/USD` bulgusu GEÇERLİ kalır.

> Araştırma görevi — kod/dağıtım yok. EVDS3 canlı veri (anahtar lokal `.dev.vars`).
> Tarih: 2026-06-25. Hedefler (analist, Bürümcekçi-tarzı, milyar USD):
> - **Toplam swap (net, stok):** 27.02 = 12,9 → 19.06 = 17,5
> - **Net dış varlık (swap hariç):** 27.02 = 80,9 → 19.06 = 36,8

---

## 0. TL;DR — Reprodüksiyon kararı

| Büyüklük | EVDS'ten üretilebilir mi? | Formül | Eşleşme |
|---|---|---|---|
| **Net dış varlık (swap DAHİL)** | ✅ **EVET — kapalı form, günlük, kesin** | `(TP.AB.A02 − TP.AB.A11 − TP.AB.A14)/USD` | ±0,04 mlr (her iki tarih) |
| **Swap stoku (12,9 → 17,5)** | ⚠️ **HAYIR — günlük tam kaynak EVDS'te yok** | en yakın proxy: SDDS `TP.DOVVARNC.K15` (aylık) | +3,5 / +2,8 mlr sapma |
| **Net dış varlık (swap HARİÇ)** | ⚠️ **Yalnız swap kadar belirsiz** | `net_dahil − swap` | net yarısı kesin, swap yarısı manuel |

**Kritik bulgu:** Analistin *swap-dahil* net dış varlığı EVDS analitik bilançodan **birebir** (±0,04)
çıkıyor. Geriye kalan tek manuel girdi **swap stoku**; o da bilançoda değil, **bilanço-dışı vadeli
(forward) bacakta**. Bu, "her şey manuel" varsayımını daraltır: artık net rezervin yarısı otomatiktir.

---

## 1. En iyi-uyum formüller (kapalı form, EVDS kodlarıyla)

### 1a. Net dış varlık (swap dahil) — KESİN
```
net_dis_varlik_dahil(t) = ( TP.AB.A02 − TP.AB.A11 − TP.AB.A14 ) / TP.DK.USD.A.YTL / 1e6      [mlr USD]
```
Cebirsel olarak özdeş eşdeğerleri (hepsi aynı sayı):
```
= (A02 − A10 + A13)/USD                 # = standart NIR + Kamu/Diğer YP mevduat
= NIR + A13                             # NIR = (A02−A10)/USD  (mevcut dashboard)
```
çünkü bilanço kimlikleri: `A10 = A11 + A12`, `A12 = A13 + A14`.

**Yorum:** Analistin "net dış varlık"ı, standart NIR'a **Kamu Sektörü ve Diğer YP Mevduatı (A13)**
kalemini **geri ekler** (kamu mevduatını "dış borç/yükümlülük" saymaz). Banka YP mevduatı (A14) ve
yurt dışı yerleşik yükümlülükler (A11) düşülür. Brüt force tarama bu formülün **tek** (cebirsel olarak)
çözüm olduğunu doğruladı.

### 1b. Swap stoku — KAPALI FORM YOK (en yakın proxy aylık)
```
swap_proxy(ay) = − TP.DOVVARNC.K15 / 1000      [mlr USD]   # SDDS: vadeli+future kısa poz., swapların forward bacağı dahil
```
Doğru kavram (IMF SDDS "predetermined short-term net drains / forward leg of currency swaps") ama
analistin rakamından **sistematik ~3 mlr yüksek** ve **aylık** (günlük değil). → tam reprodüksiyon değil.

### 1c. Net dış varlık (swap hariç) — türev
```
net_dis_varlik_haric(t) = net_dis_varlik_dahil(t) − swap(t)
```
EVDS yarısı (`net_dahil`) kesin; `swap(t)` manuel/belirsiz kaldığı için sonuç da o kadar belirsiz.

---

## 2. Hedefe karşı tablo (milyar USD)

### Net dış varlık (swap dahil) — `(A02−A11−A14)/USD`
| Tarih | A02 (Dış Varlık) | A11 (Yurtdışı yük.) | A14 (Banka YP mevd.) | **Hesap** | Hedef (net_haric+swap) | **Residual** |
|---|---|---|---|---|---|---|
| 27-02-2026 | 212,88 | 16,11 | 102,96 | **93,81** | 80,9 + 12,9 = 93,8 | **+0,01** |
| 19-06-2026 | 159,87 | 14,62 | 90,99 | **54,26** | 36,8 + 17,5 = 54,3 | **−0,04** |

### Swap stoku — aday kaynaklar
| Aday (kod) | 27-02 / end-Şub | 19-06 / end-May | Hedef 12,9 / 17,5 | Residual | Karar |
|---|---|---|---|---|---|
| **SDDS forward/swap** `TP.DOVVARNC.K15` (aylık) | 16,41 | 20,33 | 12,9 / 17,5 | **+3,5 / +2,8** | doğru kavram, ~3 mlr yüksek |
| → kısa vadeli ≤1m `K16` | 0,26 | 3,97 | — | trend bozuk | ✗ |
| → >3m-1y `K18` | 16,15 | 16,36 | — | seviye yüksek, düz | ✗ |
| **CBRT swap işlemleri** `TP.SWAPTEKTAR.TOTALSTOK*` (günlük) | 3,42 (satım) | 1,83 (alım) | 12,9 / 17,5 | büyüklük yanlış | ✗ (önceden elenmiş — teyit) |
| **türetilmiş** = net_dahil − net_haric | 12,91 | 17,46 | 12,9 / 17,5 | **+0,01 / −0,04** | ✓ ama döngüsel (analist kimliği) |

### Net dış varlık (swap hariç) — doğrudan bilanço kombinasyonu var mı?
| Aday | 27-02 | 19-06 | Hedef 80,9 / 36,8 | Karar |
|---|---|---|---|---|
| brüt force (A02 ± {A08,A10,A11,A12,A13,A14,A081}, ±1, ≤4 terim, tol ±0,4) | — | — | — | **HİÇBİR eşleşme yok** |
| `(A02−A11−A14) − \|K15\|` | 77,4 | 33,9 | 80,9 / 36,8 | K15 ~3 mlr fazla düşüyor |

→ **Swap-hariç doğrudan bilançodan çıkmıyor**; swap bilanço-dışı olduğu için zorunlu olarak harici girdi gerekir.

---

## 3. Kullanılan EVDS serileri

**Datagroup keşfi (yeni endpoint):** `https://evds3.tcmb.gov.tr/igmevdsms-dis/serieList/code={DATAGROUP}&type=json`
(path-stili, `?` yok; anahtar header'da). Bu, eski ölü `/service/evds/serieList`'in çalışan karşılığı.

| Kod | Ad (EN) | Frekans | Datagroup | Rol |
|---|---|---|---|---|
| `TP.AB.A02` | A.1 Foreign Assets | İş günü | bie_abanlbil | net dahil — varlık tabanı |
| `TP.AB.A10` | P.1 Total Foreign Liabilities | İş günü | bie_abanlbil | (= A11+A12) |
| `TP.AB.A11` | P.1a Liabilities to Non-Residents | İş günü | bie_abanlbil | net dahil — düşülen |
| `TP.AB.A12` | P.1b Liabilities to Residents | İş günü | bie_abanlbil | (= A13+A14) |
| `TP.AB.A13` | P.1ba Public Sector & Other FX Deposits | İş günü | bie_abanlbil | **geri eklenen** kalem |
| `TP.AB.A14` | P.1bb FX Deposits of Banking Sector | İş günü | bie_abanlbil | net dahil — düşülen |
| `TP.DK.USD.A.YTL` | USD alış | İş günü | bie_dkdovytl | TL→USD çevrim |
| `TP.DOVVARNC.K15` | 2.2.1 Short Positions (forward leg of currency swaps dahil) | **Aylık** | bie_ulusdovlkd (SDDS) | swap proxy |
| `TP.DOVVARNC.K14/.K19` | net / long pozisyon | Aylık | bie_ulusdovlkd | swap bağlamı |
| `TP.REZVARPD.K1` | 1.1 Official Reserve Assets | Aylık | bie_ulusdovlkd | çapraz teyit (=brüt) |
| `TP.SWAPTEKTAR.TOTALSTOK*` | Total Outstanding (Buy/Sell) | İş günü | bie_swaptektarf | elendi |

**Veri bütünlüğü çapaları (hepsi doğrulandı):** 27-02 haftalık toplam/altın/döviz = 210,3 / 136,8 / 73,4 ✓;
A02_usd(19-06)=159,9 ✓; NIR(19-06)=48,2 ✓; SDDS Official Reserve Assets(end-Şub)=210,3 = haftalık brüt ✓.

**EVDS'te BULUNAMAYAN (manuel kalması gereken) bileşen:**
- **Analistin tam swap stoku (12,9 / 17,5), günlük.** Hiçbir günlük EVDS serisi vermiyor.
  - SDDS `K15` (bilanço-dışı forward bacağı) doğru kavram ama (a) **aylık**, (b) **~3 mlr yüksek**
    (outright forward + olası altın/FX swap'ları içerir; analist daha dar tanım kullanıyor),
    (c) yabancı MB swap'ları ayrı yayımlanmadığından kompozisyon doğrulanamaz.
  - CBRT'nin kendi swap piyasası (`SWAPTEKTAR`) 2026 ortasında ~0'a inmiş → büyük swap stoku artık
    CBRT operasyonel swap'ı değil, **bankalarla açık vadeli yükümlülük** (SDDS forward).

---

## 4. Çapraz tutarlılık (kimlik: net_dahil = net_haric + swap)

| Tarih | EVDS net_dahil (A02−A11−A14) | Analist (net_haric + swap) | Residual |
|---|---|---|---|
| 27-02-2026 | **93,81** | 80,9 + 12,9 = 93,8 | **+0,01** |
| 19-06-2026 | **54,26** | 36,8 + 17,5 = 54,3 | **−0,04** |

→ Kimlik **iki tarihte de ±0,04 içinde tutuyor.** Analistin üç rakamı (net_haric, swap, ima edilen net_dahil)
EVDS-ölçülü net_dahil ile tam tutarlı. **Kırılma noktası yok**; sistem içsel olarak tutarlı ve tek
serbest parametre swap bölünmesi.

**Neden A13 geri ekleniyor (ekonomik mantık):** Banka YP mevduatı (A14) swap yoluyla yatırılan FX'i
*zaten içerir ve düşülür* → bilanço-içi swap netlenmiştir. Geriye kalan analist-swap'ı (12,9/17,5)
**bilanço-dışı forward teslim yükümlülüğü** (SDDS K15 kavramı), bilançoda görünmez. Kamu mevduatı (A13)
dış yükümlülük sayılmadığı için geri eklenir. Bu yüzden:
`net_dahil = bilanço-içi net pozisyon`, `swap = bilanço-dışı forward drenaj`, `net_haric = ikisinin farkı`.

---

## 5. Güven + dashboard önerisi

**Güven:**
- Net dış varlık (swap dahil) formülü: **ÇOK YÜKSEK.** Cebirsel kimlik + iki tarihte ±0,04 + tüm
  aralıkta düzgün günlük seri + çapa serileri birebir. Bu artık "doğrulanmış zemin".
- Swap stoku: **DÜŞÜK (otomasyon için).** Doğru EVDS kavramı SDDS K15 ama aylık + ~3 mlr offset +
  analist tanımına oturmuyor. Net-hariç bu yüzden ancak swap kadar güvenilir.

**Somut dashboard önerisi (onaylanırsa ayrı faz):**
1. **YENİ otomatik kart — "Net Dış Varlık (swap dahil)"** = `(A02−A11−A14)/USD`, **günlük**.
   M-001'e A11+A14 ekle (A02/A10/USD zaten var), M-002'ye tek satır formül. Mevcut NIR kartının
   yanına "kamu mevduatı dahil net" olarak. **Bedava, kesin, günlük.** → güçlü öneri.
2. **Swap stoku — MANUEL KALSIN** (mevcut karar doğru). İsteğe bağlı iyileştirme: SDDS `K15`'i
   **bilgilendirici ikincil çizgi** olarak göster ("IMF SDDS forward/swap pozisyonu, aylık;
   analist 'swap hariç net' tanımıyla ~3 mlr farklı") — kullanıcıya manuel girişi için **referans
   bağlama** verir, ama net-hariç hesabını otomatik bağlama.
3. **Swap-hariç net** = otomatik `net_dahil` − manuel `swap`. Böylece kullanıcı yalnız swap'ı girer,
   gerisi günlük otomatik akar (bugün ikisi de manuel/yarı-manuel). UI caveat'ı korunur.

**Tek cümle karar:** *Net dış varlık (swap dahil) `(A02−A11−A14)/USD` ile ±0,04 mlr içinde günlük olarak
EVDS'ten birebir üretilir ve dashboard'a otomatik eklenmelidir; swap stoku (12,9/17,5) hiçbir günlük EVDS
serisinde yoktur (en yakın SDDS `TP.DOVVARNC.K15`, aylık, ~3 mlr yüksek) ve manuel kalmalıdır → swap-hariç
net = otomatik net_dahil − manuel swap.*
