import type { ProfileGroup } from "@tagpress/domain";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "../../../lib/language.tsx";
import { describeGlyphRule, describeProfile, fontName } from "../mantik/describe.ts";
import { useWork } from "../mantik/work.tsx";
import { CenterColumn, Panel, PanelSection, TextField, Tooltip, Workspace } from "../../../tezgah/index.ts";
import { tt } from "../dil.ts";
import { Sema } from "../kurallar/Sema.tsx";
import { Yazi } from "../Yazi.tsx";
import "./ozet.css";

/**
 * Özet: başlıkta dilin adı ve tek soluk satırda açıklama, tarz notu, taslak notu; ortada iki sütunda her grubun kuralı tek
 * paragrafta ve "Düzenle" bağlantısı; sağda yazı örnek föyü (örnek yazı, fontlar, özel karakterler, satır oranları).
 */
export default function Ozet({ onEdit }: { onEdit: (g: ProfileGroup) => void }) {
  const { t, i18n } = useTranslation("designLanguage");
  const w = useWork();
  const { current } = useLanguage();
  const p = w.value;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dil değişince yeniden hesaplanır: describeProfile cümleleri ortak i18n örneğinden okur
  const groups = useMemo(() => (p ? describeProfile(p) : []), [p, i18n.language]);
  const [sample, setSample] = useState(() => t("summary.sampleText"));
  if (!p) return null;
  const rest = groups.filter((g) => g.group !== "genel");
  const styleNote = p.ai.instructions.trim();

  const title = current?.name ?? p.name;
  const lead = [p.description.trim(), styleNote ? tt("designLanguage:describe.general.styleNote", { note: styleNote }) : "", w.hasDraft && w.changedCount > 0 ? t("summary.draftNote") : ""].filter(Boolean).join(" · ");

  return (
    <Workspace
      rightWidth={340}
      right={
        <Panel side="right" title={t("summary.sheetTitle")}>
          <PanelSection>
            <TextField value={sample} onChange={setSample} aria-label={t("summary.sampleLabel")} />
            {p.fonts.list.length === 0 && <p className="td-ozet-not">{t("summary.noFonts")}</p>}
            <ul className="td-ozet-liste">
              {p.fonts.list.map((f) => (
                <li key={f.id} className={f.enabled ? undefined : "is-kapali"}>
                  <Yazi languageId={w.languageId} file={f.file} text={sample || "Aa"} height={40} className="td-ozet-ornek" />
                  <p className="td-ozet-not">
                    {fontName(p, f.id)}
                    {` · ${t(`summary.kind.${f.kind}`)}`}
                    {` · ${f.roles.length > 0 ? f.roles.map((r) => t(`summary.role.${r}`)).join(", ") : t("summary.glyphOnly")}`}
                    {!f.enabled && ` · ${t("summary.off")}`}
                  </p>
                </li>
              ))}
            </ul>
          </PanelSection>
          {p.glyphRules.length > 0 && (
            <PanelSection heading={t("summary.glyphs")}>
              <ul className="td-ozet-liste">
                {p.glyphRules.map((r) => {
                  const font = p.fonts.list.find((f) => f.id === r.fontId);
                  const text = r.match.type === "chars" ? r.match.chars : r.match.type === "digits" ? "0123" : r.match.letters || "AM";
                  return (
                    <li key={r.id} className={`td-ozet-kural${r.enabled ? "" : " is-kapali"}`}>
                      <Yazi languageId={w.languageId} file={font?.file} text={text} height={40} className="td-ozet-ornek" />
                      <p className="td-ozet-cumle">{describeGlyphRule(p, r)}</p>
                    </li>
                  );
                })}
              </ul>
            </PanelSection>
          )}
          <PanelSection heading={t("summary.ratios")}>
            <Sema profile={p} />
          </PanelSection>
        </Panel>
      }
    >
      <CenterColumn>
        <div className="td-sayfa td-ozet">
          <header className="td-ozet-bas">
            <h1 className="td-baslik">{title}</h1>
            {lead && (
              <Tooltip content={lead}>
                <p className="td-ozet-lead">{lead}</p>
              </Tooltip>
            )}
          </header>
          <div className="td-ozet-kurallar">
            {rest.map((g) => (
              <section key={g.group} className="td-ozet-grup" aria-label={g.title}>
                <div className="td-ozet-gb">
                  <h2>{g.title}</h2>
                  <button type="button" className="td-bag" aria-label={t("summary.editFor", { group: g.title })} onClick={() => onEdit(g.group)}>
                    {t("summary.edit")}
                  </button>
                </div>
                <p>{g.sentences.join(" ")}</p>
              </section>
            ))}
          </div>
        </div>
      </CenterColumn>
    </Workspace>
  );
}
