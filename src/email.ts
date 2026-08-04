// M-006 email (Faz 10) — günlük rezerv-akışı maili (EN+TR, düz metin).
// buildSummary'nin ürettiği weeklyFlow/monthlyFlow ayrıştırmasını (Δbrüt = altın fiyat
// değerleme etkisi + "diğer") kısa ve profesyonel bir mail olarak kurar; Cloudflare
// Email Service `send_email` binding'i ile kullanıcının doğrulanmış adresine gönderir
// (doğrulanmış hedefe gönderim her planda ücretsizdir; API anahtarı/secret GEREKMEZ).
// Gövde Bloomberg chat'e kopyala-yapıştır hedefiyle tasarlandı: satır-etiketli, tablo yok.
// buildReserveEmail SAF'tır (offline test edilir). runDailyEmail cron çekirdeğidir ve
// warmCache disipliniyle ASLA fırlatmaz; hata yalnız loglanır (anahtar/sır LOGLANMAZ).

import type {
  EmailLang,
  EmailSendMessage,
  MonthlyFlowPoint,
  SummaryResponse,
  WeeklyFlowPoint,
} from "./types.ts";
import {
  buildSummary,
  defaultStart,
  type Env,
  readSummaryCache,
  readSummaryLast,
  todayDdMmYyyy,
  writeSummaryCache,
} from "./summary.ts";

// --- biçimlendirme ---------------------------------------------------------------

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_TR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

/** Tekil blok dili (EmailLang "both" iki bloğa açılır). */
type Lang = "en" | "tr";

/** ISO `yyyy-mm-dd` → "04 Aug" (EN) / "04 Ağu" (TR); `withYear` ile yıl eklenir. */
function fmtDate(iso: string, lang: Lang, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = lang === "en" ? MONTHS_EN : MONTHS_TR;
  const mon = months[Number(m[2]) - 1] ?? m[2];
  return withYear ? `${m[3]} ${mon} ${m[1]}` : `${m[3]} ${mon}`;
}

/** 1 ondalık, işaretsiz seviye: "168.9" / TR "168,9". */
function fmtLevel(v: number, lang: Lang): string {
  const s = v.toFixed(1);
  return lang === "tr" ? s.replace(".", ",") : s;
}

/** 1 ondalık, işaret AÇIK (+/-); yuvarlama sonrası -0.0 üretmez. */
function fmtSigned(v: number, lang: Lang): string {
  const r = Math.round(v * 10) / 10;
  const sign = r < 0 ? "-" : "+";
  const s = Math.abs(r).toFixed(1);
  return `${sign}${lang === "tr" ? s.replace(".", ",") : s}`;
}

/** Dil başına sabit metinler (profesyonel sell-side tonu; Bloomberg'e yapıştırılabilir). */
interface Strings {
  title: string;
  unit: string;
  level: (lvl: string, through: string, anchor: string, anchorDate: string) => string;
  levelOfficial: (lvl: string, date: string) => string;
  weeklyHead: string;
  monthlyHead: string;
  weeklyCompleted: string;
  weeklyOngoing: string;
  monthlyCompleted: string;
  monthlyOngoing: string;
  nowcastTag: string;
  gold: string;
  other: string;
  na: string;
  splitUnavailable: string;
  stale: (date: string) => string;
  note: string;
}

const STRINGS: Record<Lang, Strings> = {
  en: {
    title: "TCMB Gross Reserves",
    unit: "bn USD",
    level: (lvl, through, anchor, anchorDate) =>
      `Level: ${lvl} bn USD (nowcast, data through ${through}; last official ${anchor} on ${anchorDate})`,
    levelOfficial: (lvl, date) => `Level: ${lvl} bn USD (official weekly, ${date})`,
    weeklyHead: "Weekly change decomposition:",
    monthlyHead: "Monthly change decomposition:",
    weeklyCompleted: "Last completed week",
    weeklyOngoing: "Week-to-date",
    monthlyCompleted: "Last completed month",
    monthlyOngoing: "Month-to-date",
    nowcastTag: ", nowcast",
    gold: "gold valuation",
    other: "other",
    na: "n/a",
    splitUnavailable: "(gold/other split unavailable)",
    stale: (date) =>
      `Warning: source data currently unreachable; figures are from the last successful update (${date}).`,
    note:
      'Note: "other" = FX flows + parity effects (not pure intervention); gold is valuation-only. Source: TCMB EVDS + tqrlab nowcast.',
  },
  tr: {
    title: "TCMB Brüt Rezervler",
    unit: "mlr USD",
    level: (lvl, through, anchor, anchorDate) =>
      `Seviye: ${lvl} mlr USD (nowcast, ${through} itibarıyla; son resmi ${anchor} — ${anchorDate})`,
    levelOfficial: (lvl, date) => `Seviye: ${lvl} mlr USD (resmi haftalık, ${date})`,
    weeklyHead: "Haftalık değişim ayrıştırması:",
    monthlyHead: "Aylık değişim ayrıştırması:",
    weeklyCompleted: "Son tamamlanan hafta",
    weeklyOngoing: "Hafta içi kümüle",
    monthlyCompleted: "Son tamamlanan ay",
    monthlyOngoing: "Ay içi kümüle",
    nowcastTag: ", nowcast",
    gold: "altın değerleme",
    other: "diğer",
    na: "veri yok",
    splitUnavailable: "(altın/diğer ayrıştırması yok)",
    stale: (date) =>
      `Uyarı: kaynak veriye şu an ulaşılamıyor; rakamlar son başarılı güncellemeye aittir (${date}).`,
    note:
      'Not: "diğer" = döviz akışları + parite etkileri (saf müdahale değildir); altın yalnız fiyat değerlemesidir. Kaynak: TCMB EVDS + tqrlab nowcast.',
  },
};

// --- veri seçimi -----------------------------------------------------------------

type FlowPoint = WeeklyFlowPoint | MonthlyFlowPoint;

/** Son TAMAMLANAN dönem (nowcast olmayan son eleman); yoksa undefined. */
function lastCompleted<T extends { nowcast?: boolean }>(points: T[]): T | undefined {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p && !p.nowcast) return p;
  }
  return undefined;
}

/** Devam eden dönem (dizinin nowcast işaretli son elemanı); yoksa undefined. */
function ongoingPoint<T extends { nowcast?: boolean }>(points: T[]): T | undefined {
  const last = points[points.length - 1];
  return last?.nowcast ? last : undefined;
}

/**
 * Tek ayrıştırma satırı: "- {etiket} ({önce} -> {sonra}[, nowcast]): Δ | altın | diğer".
 * Altın parçası null ise (soft-fail) yalnız Δ + "ayrıştırma yok" yazılır — asla "null" değil.
 */
function flowLine(label: string, p: FlowPoint | undefined, s: Strings, lang: Lang, isOngoing: boolean): string {
  if (!p) return `- ${label}: ${s.na}`;
  const range = `${fmtDate(p.prevTarih, lang)} -> ${fmtDate(p.tarih, lang)}${isOngoing ? s.nowcastTag : ""}`;
  const delta = `${fmtSigned(p.delta, lang)} ${s.unit}`;
  if (p.goldPriceEffect === null || p.otherPart === null) {
    return `- ${label} (${range}): ${delta} ${s.splitUnavailable}`;
  }
  return `- ${label} (${range}): ${delta} | ${s.gold} ${fmtSigned(p.goldPriceEffect, lang)} | ${s.other} ${fmtSigned(p.otherPart, lang)}`;
}

/** Tek dil bloğu (~13 satır): başlık, seviye, haftalık + aylık ayrıştırma, caveat. */
function renderBlock(summary: SummaryResponse, lang: Lang, reportDate: string): string {
  const s = STRINGS[lang];
  const lines: string[] = [];
  lines.push(`${s.title} — ${reportDate}`);
  if (summary.meta.stale) {
    lines.push(s.stale(fmtDate(summary.meta.updatedAt.slice(0, 10), lang, true)));
  }
  lines.push("");
  const latest = summary.daily[summary.daily.length - 1];
  if (latest) {
    lines.push(
      s.level(
        fmtLevel(latest.brutRezerv, lang),
        fmtDate(latest.tarih, lang),
        fmtLevel(summary.meta.anchorBrut, lang),
        fmtDate(summary.meta.anchorDate, lang),
      ),
    );
  } else {
    lines.push(s.levelOfficial(fmtLevel(summary.meta.anchorBrut, lang), fmtDate(summary.meta.anchorDate, lang)));
  }
  lines.push("");
  lines.push(s.weeklyHead);
  lines.push(flowLine(s.weeklyCompleted, lastCompleted(summary.weeklyFlow), s, lang, false));
  lines.push(flowLine(s.weeklyOngoing, ongoingPoint(summary.weeklyFlow), s, lang, true));
  lines.push("");
  lines.push(s.monthlyHead);
  lines.push(flowLine(s.monthlyCompleted, lastCompleted(summary.monthlyFlow), s, lang, false));
  lines.push(flowLine(s.monthlyOngoing, ongoingPoint(summary.monthlyFlow), s, lang, true));
  lines.push("");
  lines.push(s.note);
  return lines.join("\n");
}

// --- kamu yüzeyi -----------------------------------------------------------------

/**
 * SAF mail üretimi: summary → {subject, text}. Ağ/binding YOK; offline test edilir.
 * `opts.now` rapor tarihidir (cron gerçek saati verir); verilmezse meta.updatedAt kullanılır.
 * `lang:"both"` → EN blok + "---" + TR blok (Bloomberg için istenen blok kopyalanır).
 */
export function buildReserveEmail(
  summary: SummaryResponse,
  opts?: { lang?: EmailLang; now?: Date },
): { subject: string; text: string } {
  const lang: EmailLang = opts?.lang ?? "both";
  const now = opts?.now ?? new Date(summary.meta.updatedAt);
  const iso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;

  const subjectLang: Lang = lang === "tr" ? "tr" : "en";
  let subject = `${STRINGS[subjectLang].title} — ${fmtDate(iso, subjectLang, true)}`;
  if (summary.meta.stale) subject += " [stale]";

  const blocks: string[] = [];
  if (lang !== "tr") blocks.push(renderBlock(summary, "en", fmtDate(iso, "en", true)));
  if (lang !== "en") blocks.push(renderBlock(summary, "tr", fmtDate(iso, "tr", true)));
  return { subject, text: blocks.join("\n\n---\n\n") };
}

/** env.EMAIL_LANG doğrulaması; tanınmayan/boş değer varsayılan "both". */
function emailLang(env: Env): EmailLang {
  const l = env.EMAIL_LANG;
  return l === "en" || l === "tr" || l === "both" ? l : "both";
}

/** Dağıtım listesi: EMAIL_TO virgülle ayrılmış adresler (boşluklar kırpılır, boşlar atılır). */
function emailRecipients(env: Env): string[] {
  return (env.EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Maili dağıtım listesindeki HER alıcıya AYRI gönderir (Promise.allSettled — bir alıcının
 * hatası diğerini engellemez; ör. henüz doğrulanmamış adres E_RECIPIENT_NOT_ALLOWED alır,
 * kalanlar yine de teslim edilir). Binding yoksa ya da liste boşsa fırlatır (çağıran yakalar).
 */
export async function sendReserveEmail(
  env: Env,
  mail: { subject: string; text: string },
): Promise<{ ok: string[]; failed: { to: string; reason: string }[] }> {
  const sender = env.EMAIL_SENDER;
  if (!sender) throw new Error("EMAIL_SENDER binding tanımlı değil.");
  const recipients = emailRecipients(env);
  if (recipients.length === 0) throw new Error("EMAIL_TO boş — dağıtım listesi tanımsız.");

  const from = { email: env.EMAIL_FROM ?? "rezerv@tqrlab.com", name: "tqrlab rezerv" };
  const results = await Promise.allSettled(
    recipients.map((to) => {
      const msg: EmailSendMessage = { to, from, subject: mail.subject, text: mail.text };
      return sender.send(msg);
    }),
  );

  const ok: string[] = [];
  const failed: { to: string; reason: string }[] = [];
  recipients.forEach((to, i) => {
    const r = results[i];
    if (!r) return;
    if (r.status === "fulfilled") ok.push(`${to} (${r.value.messageId})`);
    else failed.push({ to, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { ok, failed };
}

/**
 * Cron çekirdeği (EMAIL_CRON tetiği): summary'yi en ucuz yoldan edinir ve maili gönderir.
 * Sıra: KV cache → miss'te buildSummary (+cache ısıtma; sabah 05:30 UTC'de cache soğuktur,
 * mail cron'u aynı anda ısıtmış olur) → hata durumunda son-bilinen-iyi (stale damgalı;
 * mail konu/gövdesinde işaretlenir) → hiçbiri yoksa gönderme. ASLA fırlatmaz.
 */
export async function runDailyEmail(env: Env): Promise<void> {
  if (!env.EMAIL_SENDER) {
    console.error("[email] EMAIL_SENDER binding yok; mail atlandı.");
    return;
  }
  const start = defaultStart(env);
  const end = todayDdMmYyyy();

  let summary: SummaryResponse | null = null;
  try {
    summary = await readSummaryCache(env, start, end);
    if (!summary) {
      const built = await buildSummary(env, start, end);
      await writeSummaryCache(env, start, end, built);
      summary = built;
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[email] summary üretilemedi (${reason}); son-bilinen-iyi deneniyor.`);
    try {
      summary = await readSummaryLast(env, start);
    } catch {
      summary = null;
    }
  }
  if (!summary) {
    console.error("[email] veri yok (cache + last-known-good boş); mail atlandı.");
    return;
  }

  try {
    const mail = buildReserveEmail(summary, { lang: emailLang(env), now: new Date() });
    const { ok, failed } = await sendReserveEmail(env, mail);
    if (ok.length > 0) console.log(`[email] gönderildi: ${ok.join(", ")}`);
    for (const f of failed) console.error(`[email] gönderilemedi (${f.to}): ${f.reason}`);
    if (ok.length === 0) console.error("[email] hiçbir alıcıya gönderilemedi.");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[email] gönderim hatası: ${reason}`);
  }
}
