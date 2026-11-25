import { type ReferenceSampleView, formatSample } from "@tagpress/ai/builder/format";
import { API, type TemplateItem, apiPath } from "@tagpress/domain";
import { z } from "zod";
import { Dil, Kaynak, type ToolContext, images, json, ok, safe, text, toSource } from "./common.ts";

type Sample = ReferenceSampleView;

export { formatSample } from "@tagpress/ai/builder/format";

export function registerDataTools({ server, client }: ToolContext): void {
  server.registerTool(
    "ornekleri_getir",
    {
      title: "Örnekleri getir",
      description:
        "Kullanıcının son hâlini verdiği bitmiş etiketler (referanslar): müşteri metni, kullanıcının satırları (metin, font, punto), " +
        "şablon ve programın önerisi. Görseller (şablon + kullanıcının yazısı, küçültülmüş) sırayla eklenir; görsellere gerçekten bakın.",
      inputSchema: {
        dil: Dil,
        limit: z.number().int().min(1).max(24).default(8),
        sablon: z.string().optional().describe("Yalnızca bu şablon anahtarı."),
        split: z.enum(["train", "test"]).optional().describe("train: öğrenme kümesi, test: ayrılmış küme."),
        gorseller: z.boolean().default(true),
        genislik: z.number().int().min(120).max(600).default(320).describe("Görsel genişliği (px)."),
      },
    },
    safe(async ({ dil, limit, sablon, split, gorseller, genislik }) => {
      const q = new URLSearchParams({ limit: String(limit), w: String(genislik) });
      if (sablon) q.set("template", sablon);
      if (split) q.set("split", split);
      const r = await client.get<{ total: number; samples: Sample[] }>(`${apiPath(API.learnSamples, { lang: dil })}?${q}`);
      if (!r.samples.length) return ok(text("Referans yok (bitmiş etiket örneği yüklenmemiş). Ölçüm ve motor denemesi referans ister; yöneticinin cevaplarıyla ilerleyin, uydurma değer yazmayın."));
      const head = `${r.total} referanstan ${r.samples.length} tanesi (şablon çeşitliliğiyle seçildi). Görseller aynı sırayla aşağıda.\n\n`;
      const body = r.samples.map(formatSample).join("\n\n");
      if (!gorseller) return ok(text(head + body));
      const imgs = await images(
        client,
        r.samples.flatMap((s) => (s.imageUrl ? [s.imageUrl] : [])),
      );
      return ok(text(head + body + (imgs.failed ? `\n\n(${imgs.failed} görsel getirilemedi.)` : "")), ...imgs.content);
    }),
  );

  server.registerTool(
    "olcum_ozeti",
    {
      title: "Ölçüm özeti",
      description:
        "Referanslardan ölçülmüş tarz: satır sayısı dağılımı, satır sınıfı oranları, görünen boşluklar, doluluk, font kullanım oranları, " +
        "bağlaç düzenleri, örnek bölmeler, büyük harf / uzun metin davranışı, şablon bazında merkez ve kurdele, program ↔ kullanıcı farkı. " +
        "Her değerin yanında örnek sayısı (n) vardır; uydurma değer yok.",
      inputSchema: { dil: Dil, kaynak: Kaynak.default("yayinlanan").describe("Bağlaç listesi ve oran tohumları hangi profilden alınsın.") },
    },
    safe(async ({ dil, kaynak }) => {
      const r = await client.get<{ source: string; profileVersion: number; measurement: { findings: string[] } & Record<string, unknown> }>(
        `${apiPath(API.learnMeasure, { lang: dil })}?source=${toSource(kaynak)}`,
        120_000,
      );
      const { findings, ...rest } = r.measurement;
      const notes =
        "Birimler: oranlar en büyük satıra; boşluklar iki satırdan küçüğünün puntosuna (em); blockWidthOfCut/blockHeightOfCut kesim çapına; şablon merkezi tasarım alanına (0..1). " +
        "'Yaklaşık' satırlar (tek yazı katmanında alt alta yazılmış) boşluk ölçümüne katılmaz.";
      return ok(text(`Profil: ${r.source} v${r.profileVersion}\n\nBulgular:\n${findings.map((f) => `- ${f}`).join("\n")}\n\n${notes}`), text(json(rest)));
    }),
  );

  server.registerTool(
    "sablonlari_getir",
    {
      title: "Şablonları getir",
      description: "Tasarım dilinin şablonları: anahtar, tür, not, etiketler, yazı alanı (otomatik/elle), kurdele payı, hedef merkez, ayarların kaynağı; isteğe bağlı küçük görseller.",
      inputSchema: {
        dil: Dil,
        gorseller: z.boolean().default(true),
        gorsel_limit: z.number().int().min(0).max(60).default(16).describe("En fazla kaç küçük görsel."),
        sablonlar: z.array(z.string()).optional().describe("Yalnızca bu anahtarlar."),
        genislik: z.number().int().min(64).max(400).default(160),
      },
    },
    safe(async ({ dil, gorseller, gorsel_limit, sablonlar, genislik }) => {
      const { templates } = await client.get<{ templates: TemplateItem[] }>(apiPath(API.templates, { lang: dil }));
      const list = templates.filter((t) => !sablonlar?.length || sablonlar.includes(t.template.key));
      const rows = list.map((i) => {
        const t = i.template;
        const area = t.area.mode === "manual" ? `elle ${t.area.shape.kind}` : "otomatik";
        const prov = [...new Set(t.provenance.map((p) => `${p.field}:${p.source}`))].join(", ");
        return `- ${t.key}${t.kind !== "label" ? ` (${t.kind})` : ""}${i.fileMissing ? " · DOSYA YOK" : ""} · alan ${area} · kurdele ${t.ribbonTop} · merkez ${t.textCenter ? `(${t.textCenter.x}, ${t.textCenter.y})` : "—"}${t.printedText ? " · basılı yazı" : ""}${t.notes ? `\n  not: ${t.notes}` : ""}${t.tags.length ? `\n  etiketler: ${t.tags.join(", ")}` : ""}${prov ? `\n  kaynak: ${prov}` : ""}`;
      });
      const head = `${list.length} şablon. Kurdele payı kesim çapına oran; merkez tasarım alanına oran (0..1).\n`;
      if (!gorseller || gorsel_limit === 0) return ok(text(head + rows.join("\n")));
      const shown = list.filter((i) => !i.fileMissing).slice(0, gorsel_limit);
      const imgs = await images(
        client,
        shown.map((i) => `${apiPath(API.learnTemplateThumb, { lang: dil, key: i.template.key })}?w=${genislik}`),
      );
      return ok(text(`${head + rows.join("\n")}\n\nGörseller (sırayla): ${shown.map((i) => i.template.key).join(", ")}`), ...imgs.content);
    }),
  );
}
