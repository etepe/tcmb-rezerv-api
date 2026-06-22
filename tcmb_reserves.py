#!/usr/bin/env python3
"""
tcmb_reserves.py — TCMB Rezerv Takibi v2 (EVDS3)
=================================================

Üç katman:
  1) HAFTALIK brüt rezerv (resmi, Cuma): toplam / altın / döviz   [TP.AB.C1/C2/TOPLAM]
  2) GÜNLÜK brüt rezerv NOWCAST: son resmi Cuma çıpası + günlük analitik
     bilanço Dış Varlıkları (A02) değişimi ile ileriye taşıma. Resmi haftalık
     yayım ~1 hafta gecikmeli geldiği için, en güncel (iş günü) rezervi verir.
     >>> Bürümcekçi tarzı günlük tablolarla birebir eşleşir (test edildi). <<<
  3) NET / DOLARİZASYON: NIR = (Dış Varlıklar − Toplam Döviz Yük.)/USD [günlük],
     ve haftalık yurt içi yerleşik YP mevduat (dolarizasyon).

Metodoloji notları (DÜRÜSTLÜK):
  • Günlük brüt rezerv TOPLAMI tam reprodüksiyon. Günlük ALTIN/DÖVİZ ayrımı EVDS'den
    yapılamaz (günlük uluslararası altın fiyatı EVDS'de yok); ayrım haftalık (Cuma)
    granülaritesinde verilir.
  • NIR standart bir ölçüdür. Analistlerin "swap hariç net rezerv" rakamı kullanılan
    swap stoku ve yükümlülük tanımına göre değişir (kaynaklar arasında bile ±7 mlr$
    fark olabilir). Swap stokunu --swap ile girersen NIR'dan düşülür; yine de tanım
    farkı nedeniyle bir analistin özel rakamına birebir oturmayabilir.
  • Günlük DTH (dolarizasyon) BDDK günlük verisidir, EVDS'de haftalık (Cuma) bulunur.

Kurulum:  pip install requests pandas matplotlib ; export TCMB_EVDS_KEY="..."
Kullanım:
  python tcmb_reserves.py --weekly --start 01-10-2025 --chart
  python tcmb_reserves.py --daily                       # günlük nowcast (son ~30g)
  python tcmb_reserves.py --net                          # NIR + dolarizasyon
  python tcmb_reserves.py --daily --net --csv out.csv --chart out.png
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

import pandas as pd
import requests

EVDS_BASE = "https://evds3.tcmb.gov.tr/igmevdsms-dis/"

# Haftalık brüt rezerv (resmi, HAFTALIK-CUMA)
W_TOPLAM, W_DOVIZ, W_ALTIN = "TP.AB.TOPLAM", "TP.AB.C2", "TP.AB.C1"
# Günlük analitik bilanço (İŞ GÜNÜ)
D_DISVARLIK, D_DOVIZYUK = "TP.AB.A02", "TP.AB.A10"      # bin TL
USD_RATE = "TP.DK.USD.A.YTL"                            # alış
# Haftalık YP mevduat (dolarizasyon, HAFTALIK-CUMA)
DTH_TOTAL, DTH_RES = "TP.HPBITABLO4.1", "TP.HPBITABLO4.2"

BRAND = {"bg": "#060A14", "grid": "#1B2436", "text": "#C9D4E5", "muted": "#5B6B86",
         "blue": "#58A6FF", "green": "#3FB950", "amber": "#D29922", "red": "#F85149"}


# ----------------------------------------------------------------------------- core
def _f(v):
    if v in (None, "", "null"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _evds(series: str, start: str, end: str, key: str) -> list[dict]:
    """EVDS3 ham çağrı. Anahtar HTTP header'ında gider (2024 sonrası kural)."""
    url = EVDS_BASE + f"series={series}&startDate={start}&endDate={end}&type=json"
    r = requests.get(url, headers={"key": key, "User-Agent": "tqrlab-reserves/2.0",
                                   "Accept": "application/json"}, timeout=30)
    if "json" not in r.headers.get("content-type", "").lower():
        raise RuntimeError(f"EVDS JSON dönmedi (HTTP {r.status_code}). Anahtar/uç kontrol et.")
    return r.json().get("items", [])


def _key(key=None):
    key = key or os.environ.get("TCMB_EVDS_KEY")
    if not key:
        raise RuntimeError("EVDS anahtarı yok: export TCMB_EVDS_KEY=... ya da --key.")
    return key


# ----------------------------------------------------------------------------- weekly
def fetch_weekly(start: str, end: str, key=None) -> pd.DataFrame:
    key = _key(key)
    items = _evds(f"{W_TOPLAM}-{W_DOVIZ}-{W_ALTIN}", start, end, key)
    rows = [{"tarih": it["Tarih"], "toplam": _f(it.get("TP_AB_TOPLAM")),
             "doviz": _f(it.get("TP_AB_C2")), "altin": _f(it.get("TP_AB_C1"))} for it in items]
    df = pd.DataFrame(rows).dropna(subset=["toplam"])
    df["tarih"] = pd.to_datetime(df["tarih"], format="%d-%m-%Y")
    df = df.sort_values("tarih").reset_index(drop=True)
    for c in ("toplam", "doviz", "altin"):
        df[c] = df[c] / 1000.0                                   # milyon → milyar
    return df


# ----------------------------------------------------------------------------- daily nowcast
def fetch_daily_nowcast(end: str | None = None, lookback_days: int = 35, key=None) -> pd.DataFrame:
    """Günlük brüt rezerv nowcast + NIR.

    brut(t) = resmi_haftalik_brut(son_cuma) + [DisVarlik_usd(t) − DisVarlik_usd(son_cuma)]
    NIR(t)  = (DisVarlik − ToplamDovizYuk)/USD
    """
    key = _key(key)
    end = end or date.today().strftime("%d-%m-%Y")
    end_dt = pd.to_datetime(end, format="%d-%m-%Y")
    start_dt = end_dt - timedelta(days=lookback_days + 10)
    start = start_dt.strftime("%d-%m-%Y")

    # 1) çıpa: aralıktaki son resmi haftalık brüt rezerv
    wk = fetch_weekly(start, end, key=key)
    if wk.empty:
        raise RuntimeError("Çıpa için haftalık veri bulunamadı.")
    anchor_dt, anchor_brut = wk.iloc[-1]["tarih"], wk.iloc[-1]["toplam"]

    # 2) günlük analitik bilanço (çıpa gününden bugüne)
    items = _evds(f"{D_DISVARLIK}-{D_DOVIZYUK}-{USD_RATE}",
                  anchor_dt.strftime("%d-%m-%Y"), end, key)
    rows = []
    for it in items:
        a02, a10, usd = _f(it.get("TP_AB_A02")), _f(it.get("TP_AB_A10")), _f(it.get("TP_DK_USD_A_YTL"))
        if a02 and usd:
            rows.append({"tarih": pd.to_datetime(it["Tarih"], format="%d-%m-%Y"),
                         "dis_varlik_usd": a02 / usd / 1e6,
                         "nir": (a02 - a10) / usd / 1e6 if a10 else None})
    d = pd.DataFrame(rows).sort_values("tarih").reset_index(drop=True)

    base_row = d[d["tarih"] == anchor_dt]
    if base_row.empty:
        raise RuntimeError("Çıpa Cuma günü günlük seride bulunamadı.")
    base_dv = base_row["dis_varlik_usd"].iloc[0]
    d["brut_rezerv"] = anchor_brut + (d["dis_varlik_usd"] - base_dv)
    d.attrs["anchor_dt"] = anchor_dt
    d.attrs["anchor_brut"] = anchor_brut
    return d[["tarih", "brut_rezerv", "nir"]]


# ----------------------------------------------------------------------------- dolarizasyon
def fetch_dolarizasyon(start: str, end: str, key=None) -> pd.DataFrame:
    key = _key(key)
    items = _evds(f"{DTH_TOTAL}-{DTH_RES}", start, end, key)
    rows = [{"tarih": it["Tarih"], "yp_toplam": _f(it.get("TP_HPBITABLO4_1")),
             "yp_yurtici": _f(it.get("TP_HPBITABLO4_2"))} for it in items]
    df = pd.DataFrame(rows).dropna(subset=["yp_toplam"])
    df["tarih"] = pd.to_datetime(df["tarih"], format="%d-%m-%Y")
    df = df.sort_values("tarih").reset_index(drop=True)
    for c in ("yp_toplam", "yp_yurtici"):
        df[c] = df[c] / 1000.0
    return df


# ----------------------------------------------------------------------------- output
def print_weekly(df: pd.DataFrame):
    last, prev = df.iloc[-1], df.iloc[-2]
    peak = df.loc[df["toplam"].idxmax()]
    s = lambda x: f"{x:+,.2f}"
    print(f"\n  HAFTALIK brüt rezerv — {last['tarih']:%d.%m.%Y} (resmi, Cuma)")
    print("  " + "─" * 50)
    print(f"  Toplam   {last['toplam']:>8,.2f} mlr$  ({s(last['toplam']-prev['toplam'])} h/h)")
    print(f"    Altın  {last['altin']:>8,.2f} mlr$  ({s(last['altin']-prev['altin'])})")
    print(f"    Döviz  {last['doviz']:>8,.2f} mlr$  ({s(last['doviz']-prev['doviz'])})")
    print(f"  Zirve {peak['toplam']:,.2f} ({peak['tarih']:%d.%m.%Y}) "
          f"→ bugün {100*(last['toplam']-peak['toplam'])/peak['toplam']:+.1f}%")


def print_daily(d: pd.DataFrame):
    last = d.iloc[-1]
    print(f"\n  GÜNLÜK nowcast — çıpa {d.attrs['anchor_dt']:%d.%m.%Y} (resmi {d.attrs['anchor_brut']:,.1f})")
    print("  " + "─" * 50)
    for _, r in d.tail(6).iterrows():
        flag = "  ←" if r["tarih"] == last["tarih"] else ""
        print(f"  {r['tarih']:%d.%m.%Y}  brüt {r['brut_rezerv']:>7,.1f}  |  NIR {r['nir']:>6,.1f}{flag}")


def print_dolar(df: pd.DataFrame, swap=None, nir=None):
    last = df.iloc[-1]
    print(f"\n  DOLARİZASYON (haftalık YP mevduat) — {last['tarih']:%d.%m.%Y}")
    print("  " + "─" * 50)
    print(f"  Toplam YP mevduat       {last['yp_toplam']:>8,.1f} mlr$")
    print(f"  Yurt içi yerleşik       {last['yp_yurtici']:>8,.1f} mlr$")
    if nir is not None and swap is not None:
        print(f"\n  Swap hariç net (NIR − swap) = {nir - swap:,.1f} mlr$  (NIR {nir:,.1f} − swap {swap:,.1f})")
        print("  [uyarı: tanım/yükümlülük farkı nedeniyle bir analistin özel rakamına birebir oturmayabilir]")


def make_chart(wk: pd.DataFrame, daily: pd.DataFrame | None, path: str) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates

    plt.rcParams.update({"font.family": "DejaVu Sans", "figure.facecolor": BRAND["bg"],
                         "axes.facecolor": BRAND["bg"], "savefig.facecolor": BRAND["bg"],
                         "text.color": BRAND["text"], "xtick.color": BRAND["muted"],
                         "ytick.color": BRAND["muted"], "axes.edgecolor": BRAND["grid"]})
    fig, ax = plt.subplots(figsize=(11, 5.6), dpi=150)
    x = wk["tarih"]
    ax.fill_between(x, 0, wk["doviz"], color=BRAND["blue"], alpha=0.85, label="Döviz (haftalık)", lw=0)
    ax.fill_between(x, wk["doviz"], wk["toplam"], color=BRAND["amber"], alpha=0.85, label="Altın (haftalık)", lw=0)
    ax.plot(x, wk["toplam"], color=BRAND["text"], lw=1.3)

    peak = wk.loc[wk["toplam"].idxmax()]
    ax.scatter([peak["tarih"]], [peak["toplam"]], color=BRAND["red"], zorder=6, s=26)
    ax.annotate(f"Zirve {peak['toplam']:,.0f}", (mdates.date2num(peak["tarih"]), peak["toplam"]),
                textcoords="offset points", xytext=(-6, 10), ha="right", color=BRAND["text"],
                fontsize=9, fontweight="bold")
    wk_last = wk.iloc[-1]
    ax.scatter([wk_last["tarih"]], [wk_last["toplam"]], color=BRAND["green"], zorder=6, s=26)

    if daily is not None and len(daily) > 1:
        dd = daily[daily["tarih"] >= wk_last["tarih"]]
        ax.plot(dd["tarih"], dd["brut_rezerv"], color=BRAND["green"], lw=1.6, ls="--",
                marker="o", ms=3, label="Günlük nowcast")
        dl = dd.iloc[-1]
        ax.annotate(f"{dl['brut_rezerv']:,.0f}\n{dl['tarih']:%d.%m}",
                    (mdates.date2num(dl["tarih"]), dl["brut_rezerv"]),
                    textcoords="offset points", xytext=(9, -4), ha="left", color=BRAND["green"],
                    fontsize=9, fontweight="bold")

    ax.set_title("TCMB Uluslararası Rezervler  ·  haftalık + günlük nowcast, milyar USD",
                 color=BRAND["text"], fontsize=13, fontweight="bold", loc="left", pad=12)
    ax.grid(True, color=BRAND["grid"], lw=0.6, alpha=0.5)
    ax.set_ylim(0, wk["toplam"].max() * 1.12)
    ax.margins(x=0.02)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b'%y"))
    leg = ax.legend(loc="lower left", frameon=False, fontsize=9)
    for t in leg.get_texts():
        t.set_color(BRAND["text"])
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    fig.text(0.992, 0.02, "tqrlab", ha="right", color=BRAND["muted"], fontsize=10, style="italic")
    fig.text(0.008, 0.02, "Kaynak: TCMB EVDS (haftalık TP.AB.C + günlük analitik bilanço A02)",
             ha="left", color=BRAND["muted"], fontsize=8)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    return path


# ----------------------------------------------------------------------------- CLI
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="TCMB rezerv takibi v2 (EVDS3)")
    p.add_argument("--weekly", action="store_true", help="haftalık brüt rezerv")
    p.add_argument("--daily", action="store_true", help="günlük brüt rezerv nowcast + NIR")
    p.add_argument("--net", action="store_true", help="dolarizasyon (+swap hariç net, --swap ile)")
    p.add_argument("--start", default=(date.today() - timedelta(days=365)).strftime("%d-%m-%Y"))
    p.add_argument("--end", default=date.today().strftime("%d-%m-%Y"))
    p.add_argument("--swap", type=float, default=None, help="swap stoku (mlr$) — net hesabı için")
    p.add_argument("--csv", nargs="?", const="tcmb_rezerv.csv")
    p.add_argument("--chart", nargs="?", const="tcmb_rezerv.png")
    p.add_argument("--key", default=None)
    args = p.parse_args(argv)
    if not (args.weekly or args.daily or args.net):
        args.weekly = True  # varsayılan

    try:
        wk = fetch_weekly(args.start, args.end, key=args.key)
        daily = fetch_daily_nowcast(end=args.end, key=args.key) if (args.daily or args.chart) else None
        dol = fetch_dolarizasyon(args.start, args.end, key=args.key) if args.net else None
    except Exception as e:
        print(f"HATA: {e}", file=sys.stderr)
        return 1

    if args.weekly:
        print_weekly(wk)
    if args.daily and daily is not None:
        print_daily(daily)
    if args.net and dol is not None:
        nir = daily["nir"].iloc[-1] if daily is not None else None
        print_dolar(dol, swap=args.swap, nir=nir)

    if args.csv:
        out = wk.rename(columns={"tarih": "Tarih"}).copy()
        out["Tarih"] = out["Tarih"].dt.strftime("%Y-%m-%d")
        out.to_csv(args.csv, index=False)
        print(f"\n  CSV  → {args.csv}")
    if args.chart:
        make_chart(wk, daily, args.chart)
        print(f"  PNG  → {args.chart}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
