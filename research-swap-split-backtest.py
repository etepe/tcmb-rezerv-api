#!/usr/bin/env python3
"""
research-swap-split-backtest.py — TCMB swap ayrıştırması doğrulama (kabul testi)
================================================================================
`Rezerv/` klasöründeki 41 günlük analist tablosundan (Bürümcekçi-tarzı, 25.03–05.06.2026)
OCR ile çıkarılan seriyi, CANLI EVDS verisine karşı doğrular.

Kesinleştirilen yöntem (hepsi milyar USD, günlük iş günü):
  net_dahil(t)   = (TP.AB.A02 − TP.AB.A11 − TP.AB.A14) / TP.DK.USD.A.YTL / 1e6   # ≡ NIR + A13
  yerli_banka(t) = (TP.SWAPTEKTAR.TOTALSTOKALIMYONLU − TP.SWAPTEKTAR.TOTALSTOKSATIMYONLU) / 1000
  yabanci_mb     = 16.4   # sabit (yabancı-MB swap anlaşması olayında güncellenir)
  toplam_swap(t) = yabanci_mb + yerli_banka(t)
  net_haric(t)   = net_dahil(t) − toplam_swap(t)

Kullanım:  TCMB_EVDS_KEY .dev.vars'tan okunur (ya da ortamdan).  python3 research-swap-split-backtest.py
"""
from __future__ import annotations
import os, re, sys, json, urllib.request

EVDS_BASE = "https://evds3.tcmb.gov.tr/igmevdsms-dis/"
YMB = 16.4                # yabancı-MB swap sabiti (2026)
TOL = 0.5                 # kabul eşiği (mlr USD)

# OCR ile çıkarılan analist serisi: (tarih, brut, altin, doviz, net_haric, toplam_swap, yabanci_mb, yerli_banka)
# None = o tablo formatında gösterilmemiş. 04-08 ikinci görselin düzeltilmiş okuması alındı (ymb 28.6 OCR hatasıydı).
ANALYST = [
    ("2026-03-25",160.7,113.0,47.7,26.5,None,None,None),
    ("2026-03-26",156.3,110.2,46.1,22.7,None,None,None),
    ("2026-03-27",155.5,109.9,45.6,22.5,None,None,None),
    ("2026-03-31",151.2,113.0,38.2,18.7,None,None,None),
    ("2026-04-01",160.1,106.6,53.5,19.5,None,None,None),
    ("2026-04-02",160.6,104.5,56.2,19.8,None,None,None),
    ("2026-04-03",162.1,104.5,57.6,20.2,None,None,None),
    ("2026-04-06",160.5,104.5,56.0,18.7,28.1,16.4,11.7),
    ("2026-04-07",161.7,105.8,55.9,21.3,25.7,16.4,9.3),
    ("2026-04-08",164.0,107.1,56.9,23.7,25.3,16.4,9.0),
    ("2026-04-09",169.3,105.5,63.7,31.7,24.2,16.4,7.8),
    ("2026-04-10",170.8,106.0,64.8,32.8,23.5,16.4,7.2),
    ("2026-04-13",172.1,105.3,66.8,35.4,22.6,16.4,6.2),
    ("2026-04-14",173.1,106.5,66.6,38.9,20.6,16.4,4.2),
    ("2026-04-15",174.5,108.0,66.5,41.2,19.5,16.4,3.2),
    ("2026-04-16",176.7,108.3,68.4,43.8,19.3,16.4,2.9),
    ("2026-04-17",174.4,107.9,66.5,41.4,19.0,16.4,2.7),
    ("2026-04-20",175.0,107.7,67.4,41.3,18.7,16.4,2.3),
    ("2026-04-21",176.1,107.6,68.4,42.1,18.1,16.4,1.8),
    ("2026-04-24",171.2,109.9,61.3,38.7,17.7,16.4,1.4),
    ("2026-04-27",170.4,110.4,59.9,37.4,17.7,16.4,1.4),
    ("2026-04-28",168.7,108.3,60.4,37.4,17.6,16.4,1.2),
    ("2026-04-30",165.5,108.8,56.6,38.6,17.2,16.4,0.8),
    ("2026-05-05",162.9,107.1,55.7,35.4,15.9,16.4,-0.4),
    ("2026-05-07",170.6,111.4,59.1,39.5,16.2,16.4,-0.2),
    ("2026-05-08",171.5,110.9,60.6,40.4,16.1,16.4,-0.3),
    ("2026-05-11",169.9,109.5,60.4,38.9,16.0,16.4,-0.4),
    ("2026-05-12",173.4,110.6,62.8,42.3,15.8,16.4,-0.5),
    ("2026-05-13",173.2,110.4,62.8,41.8,15.0,16.4,-1.3),
    ("2026-05-14",173.6,110.5,63.1,42.0,14.7,16.4,-1.6),
    ("2026-05-15",168.6,107.3,61.3,39.8,14.6,16.4,-1.7),
    ("2026-05-18",166.4,107.0,59.4,38.3,14.8,16.4,-1.6),
    ("2026-05-21",166.0,107.0,59.0,38.4,16.5,16.4,0.1),
    ("2026-05-22",160.1,106.4,53.7,30.8,18.2,16.4,1.9),
    ("2026-05-25",160.4,106.4,54.0,31.2,18.6,16.4,2.3),
    ("2026-05-26",158.7,106.5,52.2,28.2,19.2,16.4,2.8),
    ("2026-06-01",158.0,105.4,52.6,24.8,18.8,16.4,2.4),
    ("2026-06-02",160.8,106.2,54.6,28.9,18.1,16.4,1.7),
    ("2026-06-03",160.6,104.2,56.4,29.7,18.0,16.4,1.6),
    ("2026-06-04",160.5,104.8,55.7,30.7,17.8,16.4,1.4),
]

CODES = ("TP.AB.A02-TP.AB.A11-TP.AB.A14-TP.DK.USD.A.YTL"
         "-TP.SWAPTEKTAR.TOTALSTOKALIMYONLU-TP.SWAPTEKTAR.TOTALSTOKSATIMYONLU")


def get_key() -> str:
    k = os.environ.get("TCMB_EVDS_KEY")
    if k:
        return k.strip()
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        with open(os.path.join(here, ".dev.vars")) as f:
            for line in f:
                m = re.match(r'\s*TCMB_EVDS_KEY\s*=\s*"?([^"\r\n]+)"?', line)
                if m:
                    return m.group(1).strip()
    except FileNotFoundError:
        pass
    sys.exit("EVDS anahtarı yok: TCMB_EVDS_KEY ortam değişkeni ya da .dev.vars gerekli.")


def evds(codes: str, start: str, end: str, key: str) -> list[dict]:
    url = f"{EVDS_BASE}series={codes}&startDate={start}&endDate={end}&type=json"
    req = urllib.request.Request(url, headers={"key": key, "Accept": "application/json",
                                               "User-Agent": "tqrlab-swap-backtest/1.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        ct = r.headers.get("content-type", "")
        body = r.read().decode("utf-8", "replace")
    if "json" not in ct.lower():
        sys.exit(f"EVDS JSON dönmedi (content-type={ct}). Anahtar/uç kontrol et.")
    return json.loads(body).get("items", [])


def fnum(v):
    try:
        return float(v) if v not in (None, "", "null") else None
    except (TypeError, ValueError):
        return None


def iso(t: str) -> str:
    m = re.match(r"(\d{2})-(\d{2})-(\d{4})", t or "")
    return f"{m[3]}-{m[2]}-{m[1]}" if m else (t or "")


def main() -> int:
    key = get_key()
    start = "25-02-2026"
    end = "10-06-2026"
    rows = evds(CODES, start, end, key)
    ev = {}
    for r in rows:
        ev[iso(r.get("Tarih"))] = {
            "a02": fnum(r.get("TP_AB_A02")), "a11": fnum(r.get("TP_AB_A11")),
            "a14": fnum(r.get("TP_AB_A14")), "usd": fnum(r.get("TP_DK_USD_A_YTL")),
            "alim": fnum(r.get("TP_SWAPTEKTAR_TOTALSTOKALIMYONLU")),
            "satim": fnum(r.get("TP_SWAPTEKTAR_TOTALSTOKSATIMYONLU")),
        }

    print(f"EVDS iş günü sayısı: {len(ev)}  |  analist tablosu: {len(ANALYST)}  |  YMB sabiti: {YMB}\n")
    hdr = (f"{'tarih':11} {'nh_an':>6} {'nh_hes':>6} {'Δnh':>6} | "
           f"{'yb_an':>6} {'yb_evds':>7} {'Δyb':>5} | {'sw_an':>6} {'sw_hes':>6} {'Δsw':>5} | ok")
    print(hdr); print("-" * len(hdr))
    rnh, ryb, rsw, fails = [], [], [], []
    for d, brut, alt, dov, nh_an, sw_an, ymb_an, yb_an in ANALYST:
        e = ev.get(d)
        if not e or e["a02"] is None or e["usd"] is None:
            print(f"{d:11}  EVDS verisi yok (tatil?)"); continue
        nd = (e["a02"] - (e["a11"] or 0) - (e["a14"] or 0)) / e["usd"] / 1e6
        yb_ev = ((e["alim"] or 0) - (e["satim"] or 0)) / 1000.0
        nh_hes = nd - YMB - yb_ev
        sw_hes = YMB + yb_ev
        dnh = nh_hes - nh_an
        dyb = (yb_ev - yb_an) if yb_an is not None else None
        dsw = (sw_hes - sw_an) if sw_an is not None else None
        rnh.append(dnh)
        if dyb is not None: ryb.append(dyb)
        if dsw is not None: rsw.append(dsw)
        ok = abs(dnh) <= TOL
        if not ok: fails.append((d, round(dnh, 2)))
        g = lambda x, w=6: (f"%{w}.1f" % x) if x is not None else " " * w
        print(f"{d:11} {nh_an:6.1f} {nh_hes:6.1f} {dnh:+6.2f} | "
              f"{g(yb_an)} {yb_ev:7.2f} {g(dyb,5)} | {g(sw_an)} {sw_hes:6.1f} {g(dsw,5)} | {'✓' if ok else '✗'}")

    def stat(name, xs):
        a = [abs(x) for x in xs]
        if not a:
            print(f"  {name}: yok"); return
        print(f"  {name}: n={len(a)}  ort|artık|={sum(a)/len(a):.3f}  maks={max(a):.2f}")

    print("\nARTIK ÖZETİ (analist − yöntem):")
    stat("net_haric  (tam yöntem)        ", rnh)
    stat("yerli_banka vs SWAPTEKTAR net  ", ryb)
    stat("toplam_swap vs 16.4+SWAPTEKTAR ", rsw)
    print(f"\nKABUL (|Δnet_haric| ≤ {TOL}):  {len(rnh)-len(fails)}/{len(rnh)} geçti.")
    if fails:
        print("  eşik dışı:", ", ".join(f"{d}({r:+})" for d, r in fails))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
