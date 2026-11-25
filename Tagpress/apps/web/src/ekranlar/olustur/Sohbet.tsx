import { BUILDER_SAMPLE_LIMITS, isBuildRunning, type Build, type BuildMessage, type BuildQuestion, type Sample } from "@tagpress/domain";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { Button, cx, Icon, IconButton, Panel, StatusDot, TextArea, useCommands } from "../../tezgah/index.ts";
import { answerBody, chatItems, composerKind, type ChatItem } from "./akis.ts";
import { adimMetni, bildirimMetni, oturumHatasi } from "./metin.ts";
import type { OlusturData } from "./useOlustur.ts";

export interface SohbetProps {
  data: OlusturData;
  build: Build;
  /** Yazı kutusunun ya da hazır cevabın gönderimi; başarılıysa true (kutu temizlenir). */
  onSend: (body: BuildMessage) => Promise<boolean>;
  onCancel: () => void;
  onAttach: () => void;
  onDropFiles: (files: File[]) => void;
  onOpenSample: (s: Sample) => void;
  onAnalyze: () => void;
  busy: string | null;
  /** Gönderim sayacı: her başarılı gönderimde artar (bütçe artırılıp yeniden gönderilen ileti dahil); kutu temizlenir. */
  sent: number;
  /** Yazı kutusunun üstünde (bütçe, anahtar, kesinti kutuları). */
  alert?: ReactNode;
}

/**
 * Sol panel (maket 5): soru-cevap akışı, örnekler ve yazı kutusu. Hazır cevaplar tek tıkla gider (birden çok soru
 * bekliyorsa seçilir, Gönder ile birlikte gider). Kutu durumun ileti türünü gönderir: soruya cevap, incelemede
 * düzeltme, örnek aşamasında not.
 */
export function Sohbet({ data, build, onSend, onCancel, onAttach, onDropFiles, onOpenSample, onAnalyze, busy, sent, alert }: SohbetProps) {
  const { t } = useTranslation("builder");
  const [text, setText] = useState("");
  const [picks, setPicks] = useState<Record<string, number>>({});
  const box = useRef<HTMLTextAreaElement | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  const pending = build.pendingQuestions.filter((q) => !q.answered);
  const pendingKey = pending.map((q) => q.id).join("|");
  const items = useMemo(() => chatItems(data.entries, new Set(pendingKey ? pendingKey.split("|") : [])), [data.entries, pendingKey]);
  const kind = composerKind(build.state);
  const working = isBuildRunning(build.state);
  const running = busy === "send" || build.turn !== null || working;
  const canWrite = kind !== null && !running;

  // Bekleyen soru değişince eski seçimler düşer.
  useEffect(() => setPicks({}), [pendingKey]);
  useEffect(() => {
    if (!sent) return;
    setText("");
    setPicks({});
  }, [sent]);

  // Yeni girdi ya da canlı metin gelince akışın sonuna kay.
  const liveLen = data.live?.text.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [items.length, liveLen]);

  const send = async () => {
    if (!canWrite) return;
    const v = text.trim();
    const body = kind === "answer" ? answerBody(pending, picks, v) : v ? { kind, text: v } : null;
    if (!body) return;
    if (await onSend(body)) {
      setText("");
      setPicks({});
    }
  };

  const pick = (q: BuildQuestion, option: number) => {
    if (!canWrite || kind !== "answer") return;
    // Tek soru bekliyorsa ve kutu boşsa hazır cevap hemen gider.
    if (pending.length === 1 && !text.trim()) {
      void onSend({ kind: "answer", answers: [{ questionId: q.id, option }] });
      return;
    }
    setPicks((p) => (p[q.id] === option ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== q.id)) : { ...p, [q.id]: option }));
  };

  useCommands("tasarimDili", {
    "tasarimDili.send": (e) => {
      if (e.target !== box.current) return false;
      void send();
    },
    "tasarimDili.focusComposer": () => box.current?.focus(),
    "tasarimDili.attach": () => onAttach(),
  });

  const placeholder = !kind ? t("composer.closed") : running ? t("composer.running") : t(`composer.placeholder.${kind}`);
  const samples = build.samples;
  const unmeasured = samples.filter((s) => s.status === "uploaded" && !s.excluded).length;
  const canAttach = ["intake", "samples", "review", "awaiting-user"].includes(build.state) && samples.length < BUILDER_SAMPLE_LIMITS.maxFiles;

  return (
    <Panel
      side="left"
      title={t("chat.title")}
      footer={
        <>
          <div className="ol-ornekler" onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropFiles(e, onDropFiles)}>
            <div className="ol-sh">
              <span>{t("samples.yours", { count: samples.length })}</span>
              {unmeasured > 0 && build.currentRev > 0 && (
                <Button size="mini" variant="quiet" icon="refresh" disabled={running || build.state !== "review"} onClick={onAnalyze}>
                  {t("samples.measureNew", { count: unmeasured })}
                </Button>
              )}
            </div>
            <div className="ol-ups">
              {samples.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={cx("ol-up", s.excluded && "is-disi", s.status === "failed" && "is-hata")}
                  aria-label={t("samples.open", { name: s.name })}
                  onClick={() => onOpenSample(s)}
                >
                  <img src={`${s.imageUrl}?w=96`} alt="" draggable={false} />
                </button>
              ))}
              {canAttach && <IconButton icon="plus" className="ol-up-add" label={t("samples.add")} onClick={onAttach} />}
            </div>
          </div>

          {alert && <div className="ol-uyari">{alert}</div>}

          <form
            className="ol-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <IconButton icon="clip" command="tasarimDili.attach" disabled={!canAttach} onClick={onAttach} />
            <TextArea
              ref={box}
              className="ol-kutu"
              value={text}
              onChange={setText}
              rows={1}
              autoGrow
              maxLength={4000}
              disabled={!canWrite}
              placeholder={placeholder}
              aria-label={t("composer.label")}
            />
            {working ? (
              <IconButton icon="x" label={t("composer.stop")} onClick={onCancel} />
            ) : (
              <IconButton
                icon="send"
                command="tasarimDili.send"
                className={cx("ol-gonder", canWrite && (!!text.trim() || Object.keys(picks).length > 0) && "is-hazir")}
                disabled={!canWrite}
                type="submit"
              />
            )}
          </form>
        </>
      }
    >
      <div className="ol-akis" role="log" aria-label={t("chat.title")}>
        {items.length === 0 && !data.live && <p className="ol-bos">{data.entriesLoading ? t("loading") : t(`chat.empty.${build.state === "intake" ? "intake" : "other"}`)}</p>}
        {items.map((it) => (
          <Oge key={it.id} item={it} picks={picks} canPick={canWrite && kind === "answer"} onPick={pick} />
        ))}
        {data.live && data.live.text.trim() && (
          <div className="ol-msg ol-msg--ai is-canli" aria-hidden="true">
            <p>{data.live.text}</p>
          </div>
        )}
        {running && (
          <div className="ol-adim">
            <StatusDot tone="busy" label={data.step ? adimMetni(data.step) : t("step.working")} />
          </div>
        )}
        <div ref={end} />
      </div>
    </Panel>
  );
}

function dropFiles(e: React.DragEvent, onDrop: (f: File[]) => void) {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) onDrop(files);
}

function Oge({ item, picks, canPick, onPick }: { item: ChatItem; picks: Record<string, number>; canPick: boolean; onPick: (q: BuildQuestion, o: number) => void }) {
  const { t } = useTranslation("builder");
  switch (item.kind) {
    case "ai":
      return (
        <div className="ol-msg ol-msg--ai">
          <p>{item.text}</p>
        </div>
      );
    case "revision":
      return (
        <div className="ol-msg ol-msg--ai">
          <p>
            <b>{t("chat.revision", { n: item.rev })}</b>
            {item.text ? ` ${item.text}` : ""}
          </p>
        </div>
      );
    case "question": {
      const q = item.question;
      const chosen = item.pending ? picks[q.id] : item.picked;
      return (
        <div className={cx("ol-msg ol-msg--ai", item.pending && "is-bekliyor")}>
          <p>
            {q.text}
            {q.measured && typeof q.measured.value === "number" && (
              <small className="ol-olcu">{t("chat.measured", { value: formatNumber(q.measured.value, { maximumFractionDigits: 3 }), count: q.measured.n })}</small>
            )}
          </p>
          {q.options.length > 0 && (
            <div className="ol-chips" role="group" aria-label={q.text}>
              {q.options.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  className={cx("ol-chip", chosen === i && "is-on", q.suggestion === i && "is-oneri")}
                  aria-pressed={chosen === i}
                  disabled={!item.pending || !canPick}
                  onClick={() => onPick(q, i)}
                >
                  {o.label}
                  {q.suggestion === i && <span className="ol-sr">{` (${t("chat.suggested")})`}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }
    case "me":
      return (
        <div className="ol-msg ol-msg--me">
          <p>
            {item.tag === "note" && <small className="ol-etiket">{t("chat.note")}</small>}
            {item.text}
          </p>
        </div>
      );
    case "sample-edit":
      return (
        <p className="ol-sistem">
          <Icon name="pen" size={12} /> {t("chat.sampleEdit", { count: item.fields.length })}
        </p>
      );
    case "notice":
      return (
        <p className="ol-sistem">
          <Icon name="info" size={12} /> {bildirimMetni(item.code, item.params)}
        </p>
      );
    case "error":
      return (
        <p className="ol-sistem is-hata">
          <Icon name="warn" size={12} /> {oturumHatasi({ code: item.code, params: item.params })}
        </p>
      );
  }
}
