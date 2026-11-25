import { type Profile, type Reference, type Shape, type Template, checkTextPreserved, effectiveCut, shapeBounds, shapeCutDiameter } from "@tagpress/domain";
import type { ReplayMetrics } from "@tagpress/engine";
import { type Aggregate, type AggregateOptions, aggregate } from "./aggregate.ts";
import { type RefDiff, diffAll } from "./diff.ts";
import { textKey } from "./lines.ts";
import { type PatchChange, getPath, templatePath } from "./patch.ts";
import { type Robust, clamp, median, round } from "./stats.ts";

/**
 * Öneri üretimi (yalnızca istatistik; değerlendirme `evaluate.ts`). Her öneri tek bir kararı değiştirir ki ayrılmış
 * kümede etkisi ayrı ölçülebilsin. İstatistik EĞİTİM kümesinden (split: train) çıkarılır; test kümesi yalnızca ölçümdür.
 */

export type PrimaryMetric = "size" | "height" | "gap:normal" | "gap:beforeLast" | "gap:connector" | "position" | "none";

export interface ProposalDraft {
  /** Kararlı kimlik (aynı öneri yeniden üretilince eskisinin yerini alır): "sizing.fill", "template:12:textCenter"… */
  slug: string;
  /** motor: AI'sız tekrarla ölçülür; ai: yalnızca gerçek denemeyle ölçülebilir. */
  kind: "motor" | "ai";
  scope: { kind: "profile" } | { kind: "template"; key: string };
  title: string;
  summary: string;
  changes: PatchChange[];
  primary: PrimaryMetric;
  /** Öneriyi doğuran örnek sayısı. */
  count: number;
  stats: Record<string, unknown>;
  /** Öneriyi doğuran referanslar (en fazla birkaç). */
  examples: string[];
}

export interface ProposeOptions extends AggregateOptions {
  /** Eğitim kümesinde, mevcut profille AI'sız tekrar sonuçları (doluluk önerisi için). */
  replays?: ReadonlyMap<string, ReplayMetrics>;
  /** Önceden hesaplanmış farklar (yoksa hesaplanır). */
  diffs?: readonly RefDiff[];
  /** Kullanılacak küme (varsayılan "train"). */
  split?: Reference["split"] | "all";
  /** Örnek bölme önerisinde en fazla kaç örnek. */
  maxExamples?: number;
}

const fmt = (x: number, d = 2) => x.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x: number) => `%${Math.round(x * 100)}`;
const statOf = (r: Robust) => ({ n: r.n, median: round(r.median, 4), q1: round(r.q1, 4), q3: round(r.q3, 4), iqr: round(r.iqr, 4) });

const GAP_LABEL = { normal: "satır arası", beforeLast: "son küçük satırdan önceki", connector: "tek başına bağlaç çevresindeki" } as const;

/** Şablon PAD'leri (px): kullanıcı bloğunun çevresine bırakılan pay. */
const AREA_PAD = 8;
const RIBBON_PAD = 4;

export function propose(profile: Profile, templates: readonly Template[] | ReadonlyMap<string, Template>, refs: readonly Reference[], opts: ProposeOptions = {}): ProposalDraft[] {
  const tmap = templates instanceof Map ? (templates as ReadonlyMap<string, Template>) : new Map((templates as readonly Template[]).map((t) => [t.key, t]));
  const split = opts.split ?? "train";
  const pool = refs.filter((r) => split === "all" || r.split === split);
  const ids = new Set(pool.map((r) => r.id));
  const diffs = (opts.diffs ?? diffAll(pool, profile, tmap)).filter((d) => ids.has(d.id));
  const agg = aggregate(diffs, { ...opts, profile });
  const min = agg.thresholds;
  const out: ProposalDraft[] = [];
  const ok = diffs.filter((d) => d.usable);
  const sample = (pred: (d: RefDiff) => boolean, n = 6) => ok.filter(pred).slice(0, n).map((d) => d.id);

  const numeric = (path: string, to: number, title: string, summary: string, primary: PrimaryMetric, r: Robust, examples: string[], extra: Record<string, unknown> = {}) => {
    out.push({
      slug: path,
      kind: "motor",
      scope: { kind: "profile" },
      title,
      summary,
      changes: [{ target: "profile", path, from: getPath(profile, path), to }],
      primary,
      count: r.n,
      stats: { ...statOf(r), ...extra },
      examples,
    });
  };

  // 1) Görünen satır boşlukları (yaklaşık satırlar hariç).
  for (const kind of ["normal", "beforeLast", "connector"] as const) {
    const r = agg.gaps[kind];
    const cur = profile.spacing.inkGaps[kind];
    if (!r || r.n < min.minProfile) continue;
    const to = round(r.median, 2);
    if (Math.abs(to - cur) < 0.02) continue;
    numeric(
      `spacing.inkGaps.${kind}`,
      to,
      `${GAP_LABEL[kind][0]!.toLocaleUpperCase("tr")}${GAP_LABEL[kind].slice(1)} boşluk: ${fmt(cur)} → ${fmt(to)}`,
      `${r.n} referans örnekte ${GAP_LABEL[kind]} görünen boşluğun ortancası ${fmt(r.median)} (çeyrekler ${fmt(r.q1)}–${fmt(r.q3)}); profilde ${fmt(cur)}.` +
        (agg.gapsApprox[kind] ? ` Tek katmanda alt alta yazılmış ${agg.gapsApprox[kind]} satır çifti ölçüm sayılmadı.` : ""),
      `gap:${kind}`,
      r,
      sample((d) => d.user.gaps.some((g) => g.kind === kind && !g.approx)),
      { excludedApprox: agg.gapsApprox[kind] },
    );
  }

  // 2) Satır sınıfı oranları.
  const t = profile.sizing.tiers;
  for (const tier of ["secondary", "tertiary"] as const) {
    const r = agg.ratios[tier];
    if (!r || r.n < min.minProfile) continue;
    const cur = t[tier];
    const to = round(r.median * t.primary, 2);
    if (Math.abs(to - cur) < 0.02) continue;
    const label = tier === "secondary" ? "İkincil" : "Üçüncül";
    numeric(
      `sizing.tiers.${tier}`,
      to,
      `${label} satır oranı: ${fmt(cur)} → ${fmt(to)}`,
      `En büyük satırdan küçük ${r.n} satır, profil oranlarından başlayarak iki gruba ayrıldı; ${label.toLocaleLowerCase("tr")} grubun ortancası ${fmt(r.median)} (çeyrekler ${fmt(r.q1)}–${fmt(r.q3)}).`,
      "height",
      r,
      [],
    );
  }
  const rc = agg.ratios.connector;
  if (rc && rc.n >= min.minProfile && Math.abs(round(rc.median * t.primary, 2) - t.connector) >= 0.02) {
    const to = round(rc.median * t.primary, 2);
    numeric(
      "sizing.tiers.connector",
      to,
      `Tek başına bağlaç oranı: ${fmt(t.connector)} → ${fmt(to)}`,
      `Kendi satırındaki ${rc.n} bağlacın en büyük satıra oranının ortancası ${fmt(rc.median)} (çeyrekler ${fmt(rc.q1)}–${fmt(rc.q3)}).`,
      "height",
      rc,
      sample((d) => d.user.lines.some((l) => l.connector)),
    );
  }

  // 3) Bağlaç kayması (yalnızca gerçek mürekkep kutusu olan satırlar).
  const rs = agg.connectorShiftEm;
  if (rs && rs.n >= min.minProfile) {
    const to = round(rs.median, 2);
    if (Math.abs(to - profile.connectors.shiftEm) >= 0.03) {
      numeric(
        "connectors.shiftEm",
        to,
        `Bağlaç sağa kayması: ${fmt(profile.connectors.shiftEm)} → ${fmt(to)} em`,
        `İki isim arasında tek başına duran ${rs.n} bağlaç, isimlerin ortasından ortanca ${fmt(rs.median)} em sağda (çeyrekler ${fmt(rs.q1)}–${fmt(rs.q3)}).`,
        "none",
        rs,
        sample((d) => d.user.connectorShiftEm !== null),
      );
    }
  }

  // 4) Doluluk: mevcut motorun kullanıcının satırlarıyla seçtiği boyut / kullanıcınınki.
  if (opts.replays) {
    const ratios = ok.map((d) => opts.replays!.get(d.id)?.sizeRatio).filter((x): x is number => x !== undefined && Number.isFinite(x));
    if (ratios.length >= min.minProfile) {
      const med = median(ratios);
      const cur = profile.sizing.fill;
      const to = round(clamp(cur / med, 0.3, 1), 2);
      if (Math.abs(med - 1) >= 0.02 && Math.abs(to - cur) >= 0.01) {
        const r = { n: ratios.length, median: med, q1: 0, q3: 0, iqr: 0, p10: 0, p90: 0, min: 0, max: 0 };
        numeric(
          "sizing.fill",
          to,
          `Doluluk: ${pct(cur)} → ${pct(to)}`,
          `Kullanıcının satırları motora verildiğinde motorun en büyük satırı referanstakinin ortanca ${fmt(med)} katı (${ratios.length} etiket). Doluluk buna göre ${med > 1 ? "azaltılır" : "artırılır"}.`,
          "size",
          r,
          [],
          { engineOverUser: round(med, 4) },
        );
      }
    }
  }

  // 5) Şablonlar: hedef merkez, kurdele bandı, yazı alanı.
  const F = profile.output.designFramePx;
  for (const ta of Object.values(agg.templates)) {
    const tpl = tmap.get(ta.key);
    if (!tpl) continue;
    // Şablonun etkin kesimi (kendi kesimi ya da profilin `output.cut`'ı): kurdele oranının üst kenarı ve tabanı.
    const cut = effectiveCut(tpl, profile).shape;
    const D = shapeCutDiameter(cut);
    const cutTop = shapeBounds(cut).y;
    if (ta.enoughCenter) {
      const to = { x: round(ta.centerX.median / F, 3), y: round(ta.centerY.median / F, 3) };
      const cur = tpl.textCenter;
      if (!cur || Math.abs(cur.x - to.x) >= 0.01 || Math.abs(cur.y - to.y) >= 0.01) {
        out.push({
          slug: `template:${ta.key}:textCenter`,
          kind: "motor",
          scope: { kind: "template", key: ta.key },
          title: `Şablon ${ta.key}: yazı merkezi`,
          summary: `Bu şablondaki ${ta.n} etikette yazı bloğunun ortanca merkezi (${fmt(to.x, 3)}, ${fmt(to.y, 3)}); kayıtlı merkez ${cur ? `(${fmt(cur.x, 3)}, ${fmt(cur.y, 3)})` : "yok (alanın ortası)"}.`,
          changes: [{ target: "template", key: ta.key, field: "textCenter", path: templatePath(ta.key, "textCenter"), from: cur, to }],
          primary: "position",
          count: ta.n,
          stats: { centerX: statOf(ta.centerX), centerY: statOf(ta.centerY) },
          examples: ta.ids.slice(0, 6),
        });
      }
    }
    if (ta.enoughTemplate && tpl.ribbonTop > 0 && ta.ribbonViolations > 0) {
      const to = round(Math.max(0, (ta.userTop - RIBBON_PAD - cutTop) / D), 3);
      if (to < tpl.ribbonTop - 0.005) {
        out.push({
          slug: `template:${ta.key}:ribbonTop`,
          kind: "motor",
          scope: { kind: "template", key: ta.key },
          title: `Şablon ${ta.key}: kurdele payı ${pct(tpl.ribbonTop)} → ${pct(to)}`,
          summary: `Bu şablondaki ${ta.n} etiketin ${ta.ribbonViolations} tanesinde yazı kurdele bandına giriyor (en üst yazı ${Math.round(ta.userTop)} px, bant ${Math.round(ta.ribbonY ?? 0)} px'e kadar).`,
          changes: [{ target: "template", key: ta.key, field: "ribbonTop", path: templatePath(ta.key, "ribbonTop"), from: tpl.ribbonTop, to }],
          primary: "size",
          count: ta.n,
          stats: { userTop: round(ta.userTop, 1), ribbonY: ta.ribbonY === null ? null : round(ta.ribbonY, 1), violations: ta.ribbonViolations },
          examples: ta.ids.slice(0, 6),
        });
      }
    }
    if (ta.enoughTemplate && tpl.area.mode === "manual" && tpl.area.shape.kind === "rect") {
      const a = tpl.area.shape;
      const cur = { x0: a.x * F, y0: a.y * F, x1: (a.x + a.w) * F, y1: (a.y + a.h) * F };
      const b = ta.blocks;
      const u = { x0: b.x - AREA_PAD, y0: b.y - AREA_PAD, x1: b.x + b.w + AREA_PAD, y1: b.y + b.h + AREA_PAD };
      const out2 = Math.max(cur.x0 - u.x0, cur.y0 - u.y0, u.x1 - cur.x1, u.y1 - cur.y1);
      if (out2 > 2) {
        const c = (v: number) => clamp(v, 0, F);
        const n = { x0: c(Math.min(cur.x0, u.x0)), y0: c(Math.min(cur.y0, u.y0)), x1: c(Math.max(cur.x1, u.x1)), y1: c(Math.max(cur.y1, u.y1)) };
        const to: Shape = { kind: "rect", x: round(n.x0 / F, 4), y: round(n.y0 / F, 4), w: round((n.x1 - n.x0) / F, 4), h: round((n.y1 - n.y0) / F, 4), radius: a.radius };
        out.push({
          slug: `template:${ta.key}:area`,
          kind: "motor",
          scope: { kind: "template", key: ta.key },
          title: `Şablon ${ta.key}: yazı alanı genişler`,
          summary: `Bu şablondaki ${ta.n} etikette kullanıcının yazısı çizili alanın ${Math.round(out2)} px dışına taşıyor; alan, yazıları ${AREA_PAD} px payla kapsayacak kadar genişletilir (daraltılmaz).`,
          changes: [{ target: "template", key: ta.key, field: "area", path: templatePath(ta.key, "area"), from: tpl.area, to: { mode: "manual", shape: to } }],
          primary: "size",
          count: ta.n,
          stats: { overflowPx: round(out2, 1) },
          examples: ta.ids.slice(0, 6),
        });
      }
    }
  }

  // 6) Örnek bölmeler (AI ayarı): programın bölmesinin kullanıcınınkinden farklı olduğu, metni elle değişmemiş etiketler.
  const known = new Set(profile.lineBreaking.examples.map((e) => textKey(e.text)));
  // Müşteri metni değişmez: kullanıcının satırları metni birebir korumuyorsa (ayırıcı silmiş, harf değiştirmiş) örnek olamaz.
  const symbols = profile.connectors.words.filter((w) => w.trim() && !/[\p{L}\p{N}]/u.test(w));
  const differing = ok.filter(
    (d) => d.sameBreaks === false && !known.has(textKey(d.text)) && checkTextPreserved(d.user.lines.map((l) => l.text), d.text, symbols).ok,
  );
  if (differing.length >= min.minTemplate) {
    const maxN = opts.maxExamples ?? 6;
    // Farklı satır sayılarından ve kısa metinlerden seç (çeşitlilik).
    const picked: RefDiff[] = [];
    const byLines = [...differing].sort((a, b) => a.text.length - b.text.length);
    for (const n of [...new Set(byLines.map((d) => d.user.lines.length))]) {
      const d = byLines.find((x) => x.user.lines.length === n && !picked.includes(x));
      if (d && picked.length < maxN) picked.push(d);
    }
    for (const d of byLines) if (picked.length < maxN && !picked.includes(d)) picked.push(d);
    const add = picked.map((d) => ({ text: d.text, lines: d.user.lines.map((l) => l.text) }));
    out.push({
      slug: "lineBreaking.examples",
      kind: "ai",
      scope: { kind: "profile" },
      title: `Örnek bölmelere ${add.length} örnek`,
      summary: `${agg.sameBreaks.n} etiketin ${agg.sameBreaks.n - agg.sameBreaks.same} tanesinde programın satır bölmesi referanstakinden farklıydı (kenar ayırıcıları sayılmadı). Kullanıcının bölmeleri AI'a örnek olarak eklenir; etkisi yalnızca gerçek denemeyle ölçülür.`,
      changes: [{ target: "profile", path: "lineBreaking.examples", from: profile.lineBreaking.examples, to: [...profile.lineBreaking.examples, ...add] }],
      primary: "none",
      count: differing.length,
      stats: { sameBreaks: agg.sameBreaks, added: add },
      examples: picked.map((d) => d.id),
    });
  }

  return out;
}

export type { Aggregate };
