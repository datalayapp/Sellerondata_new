import { formatProfile, schemaFields } from "@tagpress/ai/builder/format";
import { API, type Language, PROFILE_GROUPS, type ProfileRecord, apiPath } from "@tagpress/domain";
import { z } from "zod";
import { Dil, Kaynak, type ToolContext, json, ok, safe, text } from "./common.ts";

// Saf biçimleyiciler oluşturucuyla ortak: `packages/ai/src/builder/format.ts`. Eski içe aktarmalar bozulmasın diye burada da dışa aktarılır.
export { BADGE, formatProfile, profileLeaves, schemaFields } from "@tagpress/ai/builder/format";

export function registerProfileTools({ server, client }: ToolContext): void {
  server.registerTool(
    "diller",
    {
      title: "Tasarım dilleri",
      description: "Uygulamadaki tasarım dillerini listeler (kimlik, ad, yayınlanmış sürüm, taslak var mı, şablon sayısı). Çalışılacak dili seçmek için ilk çağrılır.",
      inputSchema: {},
    },
    safe(async () => {
      const { languages } = await client.get<{ languages: Language[] }>(API.languages);
      if (!languages.length) return ok(text("Uygulamada hiç tasarım dili yok. Önce uygulamada (Ayarlar → Tasarım dilleri) bir dil oluşturun."));
      return ok(
        text(
          languages
            .map((l) => `- ${l.id} — ${l.name}${l.isDefault ? " (varsayılan)" : ""} · yayınlanan v${l.activeVersion ?? "—"} · taslak ${l.hasDraft ? "VAR" : "yok"} · ${l.templateCount} şablon`)
            .join("\n"),
        ),
      );
    }),
  );

  server.registerTool(
    "profil_oku",
    {
      title: "Profili oku",
      description:
        "Tasarım dilinin profilini (taslak ya da yayınlanan) alan alan okur: değer + Türkçe açıklama + kimin uyguladığı rozeti " +
        "(motor = kesin uygulanır; ai = AI'a yol gösterir; ai + motor denetimi). Taslak yoksa yayınlanan gösterilir.",
      inputSchema: {
        dil: Dil,
        kaynak: Kaynak.default("taslak").describe("taslak (varsayılan) ya da yayinlanan"),
        grup: z.enum(PROFILE_GROUPS.map((g) => g.id) as [string, ...string[]]).optional().describe("Yalnızca bu grup (ör. satir-bolme, boyut, bosluk)."),
        ham: z.boolean().default(false).describe("true: profil verisini ham JSON olarak da ekle."),
      },
    },
    safe(async ({ dil, kaynak, grup, ham }) => {
      let rec: ProfileRecord | null = null;
      let note = "";
      if (kaynak === "taslak") {
        rec = await client.get<ProfileRecord | null>(apiPath(API.profileDraft, { lang: dil }));
        if (!rec) note = "Taslak yok; yayınlanan profil gösteriliyor (taslak_yaz ilk yazımda yayınlanandan taslak açar).\n";
      }
      rec ??= await client.get<ProfileRecord>(apiPath(API.profile, { lang: dil }));
      const head = `${note}Profil: ${rec.data.name} · ${rec.status === "draft" ? "TASLAK" : "yayınlanan"} v${rec.version}${rec.note ? ` · not: ${rec.note}` : ""}`;
      return ok(text(head + formatProfile(rec, grup)), ...(ham ? [text(json(rec.data))] : []));
    }),
  );

  server.registerTool(
    "profil_semasi",
    {
      title: "Profil şeması",
      description:
        "Profilin yazılabilir alanları: yol, tür, en az/en çok, varsayılan, açıklama ve rozet. taslak_yaz yaması bu yollarla yazılır " +
        "(nesneler derin birleşir, diziler bütün olarak değişir, null alanı varsayılana bırakır). Uygulama kapalıyken de çalışır.",
      inputSchema: { grup: z.enum(PROFILE_GROUPS.map((g) => g.id) as [string, ...string[]]).optional() },
    },
    safe(async ({ grup }) => {
      const fields = schemaFields().filter((f) => !grup || f.group === grup);
      return ok(
        text(
          "Kurallar: oranlar ana satıra (sizing.tiers), boşluklar küçük satırın puntosuna (spacing.inkGaps), harf yüksekliği ve paylar kesim çapına göredir. " +
            "Kesin kurallar ilgili ayara; ayarla söylenemeyen tarz ai.instructions'a; satır bölme örnekleri lineBreaking.examples'a ({ text, lines[] }) yazılır. " +
            "Müşteri metni asla değişmez: örneklerde satırlar birleşince metin birebir aynı olmalı.",
        ),
        text(json(fields)),
      );
    }),
  );
}
