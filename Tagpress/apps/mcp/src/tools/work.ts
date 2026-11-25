import { type ReplaySideView as ReplaySide, formatReplay } from "@tagpress/ai/builder/format";
import { API, type DesignDraftWriteResult, type DesignSession, type ProfileTryResponse, type Reference, apiPath } from "@tagpress/domain";
import { z } from "zod";
import { Dil, type ToolContext, fail, images, logSession, ok, safe, text } from "./common.ts";

/** Taslak yazımı, denemeler ve oturum günlüğü araçları. */

const fmtN = (x: unknown, d = 3) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");

export { formatReplay } from "@tagpress/ai/builder/format";

export function registerWorkTools({ server, client }: ToolContext): void {
  server.registerTool(
    "taslak_yaz",
    {
      title: "Taslağa yaz",
      description:
        "Profil taslağına kısmi yama yazar (taslak yoksa yayınlanandan açılır). Nesneler derin birleşir, diziler BÜTÜN olarak değişir " +
        "(ör. lineBreaking.examples'a ekleme yaparken eski örnekleri de gönderin), null alanı varsayılana bırakır. Geçersizse hiçbir şey " +
        "kaydedilmez ve alan yollarıyla hata döner. Başarılıysa değişiklik uygulamada canlı görünür. Yayınlamaz.",
      inputSchema: {
        dil: Dil,
        yama: z.record(z.string(), z.unknown()).describe('Kısmi profil, ör. { "sizing": { "fill": 0.95 }, "ai": { "instructions": "…" } }'),
        not: z.string().min(1).max(500).describe("Bu yazımın kısa açıklaması (oturum günlüğünde görünür)."),
      },
    },
    safe(async ({ dil, yama, not }) => {
      const r = await client.post<DesignDraftWriteResult>(apiPath(API.designSessionDraft, { lang: dil }), { patch: yama, note: not });
      const ch = r.changes.length ? r.changes.map((c) => `- ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join("\n") : "(değişiklik yok: değerler zaten aynıydı)";
      return ok(text(`Taslak v${r.draft.version} kaydedildi. Değişenler:\n${ch}`));
    }),
  );

  server.registerTool(
    "motor_dene",
    {
      title: "Motor denemesi (ücretsiz)",
      description:
        "AI'sız tekrar: referansların kullanıcı satırları (metin, font, sınıf) taslak ve/veya yayınlanan profille motora verilir; boyut, " +
        "konum ve satır boşlukları kullanıcının son hâliyle (referans) karşılaştırılır. Satır bölmeyi ölçmez (o AI'ın işi; uretim_dene). " +
        "Önizlemeler: [son hâl (referans) | profil(ler)].",
      inputSchema: {
        dil: Dil,
        kaynak: z.enum(["taslak", "yayinlanan", "ikisi"]).default("ikisi"),
        limit: z.number().int().min(1).max(300).default(40),
        kume: z.enum(["test", "train", "all"]).default("test").describe("test: ayrılmış küme (önerilen), train, all."),
        sablon: z.string().optional(),
        onizleme: z.number().int().min(0).max(6).default(3),
      },
    },
    safe(async ({ dil, kaynak, limit, kume, sablon, onizleme }) => {
      const source = kaynak === "ikisi" ? "both" : kaynak === "taslak" ? "draft" : "published";
      const r = await client.post<{ refs: number; split: string; sides: ReplaySide[]; previews: Array<{ referenceId: string; url: string }> }>(
        apiPath(API.learnReplay, { lang: dil }),
        { source, limit, split: kume, previews: onizleme, ...(sablon ? { template: sablon } : {}) },
        300_000,
      );
      const summary = formatReplay(r);
      const short = r.sides.map((s) => `${s.label}: ±%10 ${s.metrics.within10}/${s.metrics.n}, boyut ×${fmtN(s.metrics.sizeRatio, 2)}, merkez ${fmtN(s.metrics.positionError, 1)} px`).join(" · ");
      const logErr = await logSession(client, dil, { kind: "trial", text: `Motor denemesi (${r.refs} referans): ${short}` });
      const imgs = await images(
        client,
        r.previews.map((p) => p.url),
      );
      return ok(text(`${summary}${r.previews.length ? `\n\nÖnizlemeler: ${r.previews.map((p) => p.referenceId).join(", ")}` : ""}${logErr ? `\n${logErr}` : ""}`), ...imgs.content);
    }),
  );

  server.registerTool(
    "uretim_dene",
    {
      title: "Gerçek üretim denemesi (ÜCRETLİ)",
      description:
        "Örnek siparişleri gerçek AI ile (Haiku) taslak ve/veya yayınlanan profille dener; kalıcı iş oluşturmaz. MALİYETLİDİR: " +
        "önce onay=false ile çağırın, tahmini maliyeti yöneticiye söyleyin; yönetici kabul ederse onay=true ile tekrar çağırın. " +
        "Öğe: metin + şablon ya da referans kimliği (referansın metni/şablonu kullanılır ve son hâliyle karşılaştırılır).",
      inputSchema: {
        dil: Dil,
        kaynak: z.enum(["taslak", "yayinlanan", "ikisi"]).default("taslak"),
        ogeler: z
          .array(
            z.object({
              metin: z.string().optional(),
              sablon: z.string().optional(),
              boyut: z.string().optional().describe('Etiket boyutu kimliği, ör. "3.8".'),
              referans: z.string().optional().describe("Referans kimliği (ornekleri_getir)."),
            }),
          )
          .min(1)
          .max(10),
        onay: z.boolean().describe("false: yalnızca tahmini maliyet. true: yönetici maliyeti onayladı, çalıştır."),
      },
    },
    safe(async ({ dil, kaynak, ogeler, onay }) => {
      const samples = [];
      for (const [i, o] of ogeler.entries()) {
        let textValue = o.metin;
        let templateKey = o.sablon ?? null;
        if (o.referans && (!textValue || !templateKey)) {
          const ref = await client.get<Reference>(apiPath(API.reference, { id: o.referans }));
          textValue ??= ref.text;
          templateKey ??= ref.templateKey;
        }
        if (!textValue) return fail(`${i + 1}. öğe: metin ya da referans gerekli.`);
        samples.push({ id: `oge-${i + 1}`, text: textValue, templateKey, ...(o.boyut ? { labelSize: o.boyut } : {}), ...(o.referans ? { referenceId: o.referans } : {}) });
      }
      const profiles = kaynak === "ikisi" ? ["published", "draft"] : [kaynak === "taslak" ? "draft" : "published"];
      const path = apiPath(API.profileTry, { lang: dil });
      const est = await client.post<ProfileTryResponse>(path, { samples, profiles, dryRun: true, mode: "ai" });
      const estimate = est.estimateUsd === null ? "bilinmiyor" : `$${est.estimateUsd.toFixed(4)}`;
      if (!onay) {
        return ok(
          text(
            `Tahmini maliyet: ${estimate} (${samples.length} örnek × ${profiles.length} profil). Hiçbir şey çalıştırılmadı.\n` +
              "Yöneticiye bu tutarı söyleyin; kabul ederse aynı öğelerle onay=true gönderin.",
          ),
        );
      }
      const r = await client.post<ProfileTryResponse>(path, { samples, profiles, mode: "ai" }, 600_000);
      const out: string[] = [`Gerçek deneme bitti. Tahmin ${estimate} · gerçekleşen $${r.costUsd.toFixed(4)}.`];
      const urls: string[] = [];
      for (const res of r.results) {
        const s = samples.find((x) => x.id === res.sampleId);
        out.push(`\n## ${res.sampleId}: ${JSON.stringify(s?.text)} · şablon ${s?.templateKey ?? "—"}${res.error ? `\nHATA: ${res.error}` : ""}`);
        for (const [label, side] of [
          ["Yayınlanan", res.published],
          ["Taslak", res.draft],
        ] as const) {
          if (!side) continue;
          const ref = side.sameBreaksAsReference === null ? "" : ` · referansla bölme ${side.sameBreaksAsReference ? "AYNI" : "FARKLI"}${side.sizeDiffVsReference === null ? "" : `, boyut farkı %${Math.round(side.sizeDiffVsReference * 100)}`}`;
          out.push(`- ${label}: ${side.lines.join(" / ")} · ${side.issues} sorun${ref}`);
          urls.push(side.previewUrl);
        }
      }
      const logErr = await logSession(client, dil, { kind: "trial", text: `Gerçek AI denemesi (${samples.length} örnek, $${r.costUsd.toFixed(4)})` });
      const imgs = await images(client, urls.slice(0, 12));
      return ok(text(out.join("\n") + (logErr ? `\n${logErr}` : "")), ...imgs.content);
    }),
  );

  server.registerTool(
    "oturum_baslat",
    {
      title: "Oturum başlat",
      description: "Uygulamadaki 'Oluştur' bölümünde yeni bir tasarım dili oturumu açar (öncekiler silinmez). Becerinin başında bir kez çağrılır.",
      inputSchema: { dil: Dil, baslik: z.string().max(200).optional() },
    },
    safe(async ({ dil, baslik }) => {
      const s = await client.post<DesignSession>(apiPath(API.designSession, { lang: dil }), { title: baslik ?? "" });
      return ok(text(`Oturum açıldı (${s.id}). Sorular, cevaplar, taslak yazımları ve denemeler uygulamada canlı görünecek.`));
    }),
  );

  server.registerTool(
    "soru_kaydet",
    {
      title: "Soru/cevap kaydet",
      description:
        "Yöneticiye sorulan soruyu ve (varsa) cevabını oturum günlüğüne yazar; uygulamada canlı görünür. Soruyu sorarken cevapsız, " +
        "cevap gelince soru + cevapla çağırın (ya da yalnızca cevap geldiğinde ikisini birlikte).",
      inputSchema: {
        dil: Dil,
        grup: z.string().min(1).max(80).describe("Soru grubu: satır bölme, boyut hiyerarşisi, bağlaçlar, özel karakterler, fontlar, hizalama, doluluk, şablon yerleşimi, kalınlık-renk, sticker…"),
        soru: z.string().min(1),
        cevap: z.string().optional(),
      },
    },
    safe(async ({ dil, grup, soru, cevap }) => {
      const base = apiPath(API.designSessionEntries, { lang: dil });
      await client.post(base, { kind: "question", group: grup, text: soru });
      if (cevap?.trim()) await client.post(base, { kind: "answer", group: grup, text: cevap });
      return ok(text(cevap?.trim() ? "Soru ve cevap kaydedildi." : "Soru kaydedildi (cevap gelince tekrar çağırın)."));
    }),
  );

  server.registerTool(
    "oturum_notu",
    {
      title: "Oturum notu",
      description: "Oturum günlüğüne serbest not yazar (özet, karar, sonraki adım). Bitirirken durum='done' verin.",
      inputSchema: {
        dil: Dil,
        metin: z.string().min(1),
        durum: z.enum(["asking", "drafting", "trying", "done"]).optional().describe("Oturum durumunu açıkça değiştir (bitirince done)."),
      },
    },
    safe(async ({ dil, metin, durum }) => {
      await client.post(apiPath(API.designSessionEntries, { lang: dil }), { kind: "note", text: metin, ...(durum ? { status: durum } : {}) });
      return ok(text(durum === "done" ? "Not yazıldı, oturum bitti olarak işaretlendi." : "Not yazıldı."));
    }),
  );

  server.registerTool(
    "oturum_oku",
    {
      title: "Oturumu oku",
      description: "Son oturumun günlüğünü okur (önceki sorular/cevaplar; kaldığı yerden devam etmek için).",
      inputSchema: { dil: Dil, son: z.number().int().min(1).max(500).default(60) },
    },
    safe(async ({ dil, son }) => {
      const s = await client.get<DesignSession>(apiPath(API.designSession, { lang: dil }));
      if (!s.id) return ok(text("Bu dil için oturum yok."));
      const rows = s.entries.slice(-son).map((e) => `[${e.at.slice(0, 16).replace("T", " ")}] ${e.kind}${e.group ? ` (${e.group})` : ""}: ${e.text}${e.paths?.length ? ` {${e.paths.join(", ")}}` : ""}`);
      return ok(text(`Oturum "${s.title}" · durum ${s.status} · ${s.entries.length} girdi\n${rows.join("\n")}`), ...(s.entries.length > son ? [text(`(${s.entries.length - son} eski girdi gösterilmedi)`)] : []));
    }),
  );

}
