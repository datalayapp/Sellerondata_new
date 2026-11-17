import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { numToInput } from '../lib/format';
import { handleNumberPaste, spliceValue, writeInputValue } from '../lib/numberPaste';
import { NumberChoiceDialog } from './NumberChoiceDialog';

type Question = { el: HTMLInputElement; start: number | null; end: number | null; text: string; asTr: number; asEn: number };

/** Uygulamada bir kez: `inputMode` decimal/numeric olan her alana belirsiz sayı yapıştırılınca okumayı kullanıcıya sordurur. */
export function NumberPasteGuard() {
  const { t } = useTranslation();
  const [q, setQ] = useState<Question | null>(null);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      handleNumberPaste(e, ({ target, text, asTr, asEn }) => {
        const el = target as HTMLInputElement;
        setQ({ el, start: el.selectionStart, end: el.selectionEnd, text, asTr, asEn });
      });
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, []);

  if (!q) return null;
  return (
    <NumberChoiceDialog
      title={t('paste.title')}
      body={t('paste.body', { value: q.text, asTr: numToInput(q.asTr), asEn: numToInput(q.asEn) })}
      cancel={t('paste.cancel')}
      readAs={(value) => t('paste.readAs', { example: q.text, value })}
      asTr={q.asTr}
      asEn={q.asEn}
      onClose={() => setQ(null)}
      onPick={(format) => {
        // alan bu arada kapanmış olabilir (form kapatıldı)
        if (q.el.isConnected) writeInputValue(q.el, spliceValue(q.el.value, q.start, q.end, numToInput(format === 'tr' ? q.asTr : q.asEn)));
        setQ(null);
      }}
    />
  );
}
