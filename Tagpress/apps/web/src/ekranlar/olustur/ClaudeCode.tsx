import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { api, ApiFailure, path } from "../../lib/api.ts";
import { type DesignSession, type DesignSessionEntry, isNotConnected, SESSION_PATH } from "../tasarim-dili/mantik/contract.ts";
import { labelFor } from "../tasarim-dili/mantik/diffView.ts";
import { type SectionId } from "../tasarim-dili/mantik/sections.ts";
import { fmtDate } from "../tasarim-dili/tarih.ts";
import { Button, Dialog, StatusDot, useToast } from "../../tezgah/index.ts";

const COMMAND = "/tasarim-dili";

/**
 * Sahibin ikinci yolu: siteyi kullanmadan, bilgisayarında Claude Code ile tasarım dili kurmak (eski Oluştur sekmesinin
 * anlatımı). Oluştur ekranının "Diğer" (⋯) menüsünden açılır; adımlar, kopyalanabilir komut ve ilgili bölümlere geçiş.
 */
export function ClaudeCodePenceresi({
  languageId,
  refCount,
  hasDraft,
  onGo,
  onClose,
}: {
  languageId: string;
  refCount: number | undefined;
  hasDraft: boolean;
  onGo: (s: SectionId) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("builder");
  const toast = useToast();
  const go = (s: SectionId) => {
    onClose();
    onGo(s);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      toast({ message: t("claudeCode.copied"), tone: "success" });
    } catch {
      toast({ message: t("claudeCode.copyFailed"), tone: "error" });
    }
  };
  return (
    <Dialog
      title={t("claudeCode.title")}
      onClose={onClose}
      footer={
        <Button variant="quiet" onClick={onClose}>
          {t("claudeCode.close")}
        </Button>
      }
    >
      <div className="ol-cc">
        <p className="ol-cc-lead">{t("claudeCode.lead")}</p>
        <ol className="ol-adimlar">
          <li>
            <span className="ol-adim-no" aria-hidden="true">
              1
            </span>
            <span>
              <b>{t("claudeCode.step1.title")}</b>
              <small>
                {t("claudeCode.step1.body")} {refCount ? t("claudeCode.step1.loaded", { n: refCount }) : t("claudeCode.step1.none")}
              </small>
              <Button size="mini" onClick={() => go("ornekler")}>
                {t("claudeCode.step1.action")}
              </Button>
            </span>
          </li>
          <li>
            <span className="ol-adim-no" aria-hidden="true">
              2
            </span>
            <span>
              <b>{t("claudeCode.step2.title")}</b>
              <small>{t("claudeCode.step2.body")}</small>
              <span className="ol-kopya">
                <code aria-label={t("claudeCode.commandLabel")}>{COMMAND}</code>
                <Button size="mini" icon="copy" onClick={() => void copy()}>
                  {t("claudeCode.copy")}
                </Button>
              </span>
              <small>{t("claudeCode.step2.note")}</small>
            </span>
          </li>
          <li>
            <span className="ol-adim-no" aria-hidden="true">
              3
            </span>
            <span>
              <b>{t("claudeCode.step3.title")}</b>
              <small>
                {t("claudeCode.step3.body")} {hasDraft ? t("claudeCode.step3.hasDraft") : ""}
              </small>
              <Button size="mini" onClick={() => go("kurallar")}>
                {t("claudeCode.step3.action")}
              </Button>
            </span>
          </li>
          <li>
            <span className="ol-adim-no" aria-hidden="true">
              4
            </span>
            <span>
              <b>{t("claudeCode.step4.title")}</b>
              <small>{t("claudeCode.step4.body")}</small>
              <Button size="mini" onClick={() => go("dene")}>
                {t("claudeCode.step4.action")}
              </Button>
            </span>
          </li>
        </ol>
        <OturumDurumu languageId={languageId} />
      </div>
    </Dialog>
  );
}

/** Son kaç kayıt gösterilir (en yenisi üstte). */
const SON_KAYIT = 8;

/**
 * Claude Code oturumunun canlı durumu (`GET /api/languages/:lang/design-session`, 4 sn'de bir): durum ve son kayıtlar
 * (Claude sordu, cevabınız, taslağa yazıldı, deneme, not). Eski Oluştur sekmesindeki "Oturum durumu" alanı.
 */
function OturumDurumu({ languageId }: { languageId: string }) {
  const { t } = useTranslation("builder");
  const session = useQuery({
    queryKey: ["designSession", languageId],
    queryFn: () => api.get<DesignSession>(path(SESSION_PATH, { lang: languageId })),
    refetchInterval: 4000,
    retry: false,
  });
  const status: Record<DesignSession["status"], string> = {
    idle: t("claudeCode.session.status.idle"),
    asking: t("claudeCode.session.status.asking"),
    drafting: t("claudeCode.session.status.drafting"),
    trying: t("claudeCode.session.status.trying"),
    done: t("claudeCode.session.status.done"),
  };
  const kind: Record<DesignSessionEntry["kind"], string> = {
    question: t("claudeCode.session.kind.question"),
    answer: t("claudeCode.session.kind.answer"),
    "draft-write": t("claudeCode.session.kind.draftWrite"),
    trial: t("claudeCode.session.kind.tryRun"),
    note: t("claudeCode.session.kind.note"),
  };
  const notConnected = session.error instanceof ApiFailure && isNotConnected(session.error.status);
  const data = session.data;
  const entries = data ? [...data.entries].reverse().slice(0, SON_KAYIT) : [];
  return (
    <section className="ol-cc-oturum" aria-labelledby="ol-cc-oturum">
      <header>
        <h3 id="ol-cc-oturum">{t("claudeCode.session.title")}</h3>
        {data && <StatusDot tone={data.status === "idle" || data.status === "done" ? "idle" : "busy"} label={status[data.status]} />}
      </header>
      {session.isLoading ? null : notConnected ? (
        <p>{t("claudeCode.session.notConnected")}</p>
      ) : session.isError ? (
        <p role="alert">{serverText(session.error)}</p>
      ) : entries.length === 0 ? (
        <p>{t("claudeCode.session.empty")}</p>
      ) : (
        <ol aria-live="polite">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <small>
                <b>{kind[e.kind]}</b> {fmtDate(e.at)}
              </small>
              <span>{e.text}</span>
              {e.paths && e.paths.length > 0 && <small>{e.paths.map(labelFor).join(", ")}</small>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
