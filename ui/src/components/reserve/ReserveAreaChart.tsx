// M-004 dashboard-ui — Haftalık brüt rezerv stacked area (React island, Recharts).
// Faz 1: yalnız haftalık. Renkler CSS değişkeninden okunur — hex hardcode YOK.
import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface WeeklyPoint {
  tarih: string;
  toplam: number;
  doviz: number;
  altin: number;
}
interface WeeklyMeta {
  peak: { tarih: string; toplam: number };
  latest: WeeklyPoint;
  count: number;
  start: string;
  end: string;
  updatedAt: string;
  unit: string;
  source: string;
  cached: boolean;
}
interface WeeklyResponse {
  weekly: WeeklyPoint[];
  meta: WeeklyMeta;
}

interface Props {
  /** Worker tabanı, ör. "https://tcmb-rezerv-api.<hesap>.workers.dev". */
  apiBase: string;
  /** Haftalık başlangıç (dd-mm-yyyy). */
  start?: string;
}

/** tqrlab marka tokenlarını CSS değişkeninden okur (hardcode yok). */
function readVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useBrandColors() {
  const [c] = useState(() => ({
    panel: readVar("--panel"),
    grid: readVar("--grid"),
    text: readVar("--text"),
    muted: readVar("--muted"),
    blue: readVar("--blue"),
    amber: readVar("--amber"),
    green: readVar("--green"),
    red: readVar("--red"),
    mono: readVar("--font-mono") || "monospace",
  }));
  return c;
}

const nfTR = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const monthTR = new Intl.DateTimeFormat("tr-TR", { month: "short", year: "2-digit" });

function fmtAxisDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : monthTR.format(d);
}
function fmtFullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "long", year: "numeric" }).format(d);
}

export default function ReserveAreaChart({ apiBase, start = "01-10-2025" }: Props) {
  const c = useBrandColors();
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const base = apiBase.replace(/\/$/, "");
    fetch(`${base}/api/weekly?start=${encodeURIComponent(start)}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return (await r.json()) as WeeklyResponse;
      })
      .then(setData)
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      });
    return () => ctrl.abort();
  }, [apiBase, start]);

  if (error) {
    return <div style={{ color: c.muted, fontFamily: c.mono, padding: "2rem" }}>Veri yüklenemedi: {error}</div>;
  }
  if (!data) {
    return <div style={{ color: c.muted, fontFamily: c.mono, padding: "2rem" }}>Yükleniyor…</div>;
  }

  const { weekly, meta } = data;
  const yMax = Math.max(...weekly.map((w) => w.toplam)) * 1.12;
  const axisTick = { fill: c.muted, fontFamily: c.mono, fontSize: 12 };

  return (
    <ResponsiveContainer width="100%" height={420}>
      <ComposedChart data={weekly} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={c.grid} strokeWidth={0.6} strokeOpacity={0.5} vertical={false} />
        <XAxis
          dataKey="tarih"
          tickFormatter={fmtAxisDate}
          tick={axisTick}
          stroke={c.grid}
          minTickGap={28}
        />
        <YAxis
          domain={[0, yMax]}
          tickFormatter={(v: number) => nfTR.format(v)}
          tick={axisTick}
          stroke={c.grid}
          width={48}
        />
        <Tooltip
          contentStyle={{
            background: c.panel,
            border: `1px solid ${c.grid}`,
            borderRadius: 8,
            fontFamily: c.mono,
            color: c.text,
          }}
          labelStyle={{ color: c.muted }}
          labelFormatter={(l: string) => fmtFullDate(l)}
          formatter={(value: number, name: string) => [`${nfTR.format(value)} mlr$`, name]}
        />
        <Legend
          wrapperStyle={{ fontFamily: c.mono, fontSize: 12, color: c.text }}
          iconType="square"
          align="left"
          verticalAlign="bottom"
        />
        {/* Stacked area: Döviz (mavi) altta, Altın (amber) üstte. */}
        <Area
          type="monotone"
          dataKey="doviz"
          name="Döviz"
          stackId="rezerv"
          stroke="none"
          fill={c.blue}
          fillOpacity={0.85}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="altin"
          name="Altın"
          stackId="rezerv"
          stroke="none"
          fill={c.amber}
          fillOpacity={0.85}
          isAnimationActive={false}
        />
        {/* Toplam çizgisi (üst kenar). */}
        <Line
          type="monotone"
          dataKey="toplam"
          name="Toplam"
          stroke={c.text}
          strokeWidth={1.3}
          dot={false}
          isAnimationActive={false}
          legendType="none"
        />
        {/* Zirve (kırmızı) + güncel (yeşil) işaretleri. */}
        <ReferenceDot
          x={meta.peak.tarih}
          y={meta.peak.toplam}
          r={4}
          fill={c.red}
          stroke="none"
          label={{ value: `Zirve ${nfTR.format(meta.peak.toplam)}`, position: "top", fill: c.text, fontSize: 11 }}
        />
        <ReferenceDot
          x={meta.latest.tarih}
          y={meta.latest.toplam}
          r={4}
          fill={c.green}
          stroke="none"
          label={{ value: nfTR.format(meta.latest.toplam), position: "top", fill: c.green, fontSize: 11 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
