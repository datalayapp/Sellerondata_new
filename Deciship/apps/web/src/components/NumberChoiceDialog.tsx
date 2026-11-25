import { useEffect, useRef } from 'react';
import { numToInput } from '../lib/format';
import { Modal, ModalAction } from './ui';

/**
 * Yapıştırılan sayı iki türlü okunabildiğinde kullanıcıya sorar. Başka bir pencerenin üstünde de açılabilir: Escape yalnız
 * bu pencereyi kapatır.
 */
export function NumberChoiceDialog({
  title,
  body,
  hint,
  cancel,
  readAs,
  asTr,
  asEn,
  onPick,
  onClose,
}: {
  title: string;
  body: string;
  hint?: string;
  cancel: string;
  readAs: (value: string) => string;
  asTr: number;
  asEn: number;
  onPick: (format: 'tr' | 'en') => void;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {cancel}
          </ModalAction>
          {(['tr', 'en'] as const).map((format) => (
            <ModalAction key={format} kind="prim" onClick={() => onPick(format)}>
              {readAs(numToInput(format === 'tr' ? asTr : asEn))}
            </ModalAction>
          ))}
        </>
      }
    >
      <p>{body}</p>
      {hint && <p className="t2 s13 mt8">{hint}</p>}
    </Modal>
  );
}
