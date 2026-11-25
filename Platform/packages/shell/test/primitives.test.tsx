// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionMenu, Field, Modal, ModalAction, Pager, SlideOver, ToastProvider, errorText, rowProps, tabListKeyDown, tabStop, toast, toastDuration } from '../src/primitives.tsx';
import { ApiError } from '../src/session/client.ts';
import { sessionStatus } from '../src/session/status.ts';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => Promise<void> | void) => void;
declare const expect: any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const beforeEach: (fn: () => void) => void;
declare const afterEach: (fn: () => void) => void;
declare const vi: any; // eslint-disable-line @typescript-eslint/no-explicit-any

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (node: ReactNode) => act(() => root.render(node));
const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(document.body.querySelectorAll<HTMLElement>(sel));

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const esc = () => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const click = (el: HTMLElement | null) => act(() => void el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const mousedown = (el: HTMLElement | null) => act(() => void el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
const type = (el: HTMLElement | null, value: string) =>
  act(() => {
    (el as HTMLInputElement).value = value;
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });

function dialog(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <Modal title="Düzenle" onClose={onClose} actions={<ModalAction kind="prim">Kaydet</ModalAction>} {...props}>
      <input id="f" className="inp" />
      <div className="search">
        <input id="q" />
      </div>
    </Modal>,
  );
  return onClose;
}

describe('Modal koruması', () => {
  it('yazılmadıysa Esc, örtü ve X hemen kapatır', () => {
    const onClose = dialog();
    esc();
    mousedown($('.overlay'));
    click($('.modal .close'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect($('.modal-guard')).toBeNull();
  });

  it('yazıldıysa Esc onay şeridini açar; şerit role=alert, eylemler yerine çıkar', () => {
    const onClose = dialog();
    type($('#f'), 'x');
    esc();
    expect(onClose).not.toHaveBeenCalled();
    const strip = $('.modal-actions.modal-guard')!;
    expect(strip.getAttribute('role')).toBe('alert');
    expect(strip.querySelector('.modal-guard-text strong')!.textContent).toBe('modalGuard.title');
    expect(strip.querySelector('.modal-guard-text span')!.textContent).toBe('modalGuard.body');
    expect($$('.modal-guard-btns .pa').map((b) => b.className)).toEqual(['pa dark', 'pa danger']);
    expect(document.activeElement).toBe($('.modal-guard-btns .pa.dark'));
    expect($$('.modal-actions')).toHaveLength(1); // çağıranın eylemleri gizli
  });

  it('soru açıkken Esc ve "Düzenlemeye dön" soruyu kapatır; "Sil ve kapat" kapatır', () => {
    const onClose = dialog();
    type($('#f'), 'x');
    esc();
    esc();
    expect($('.modal-guard')).toBeNull();
    mousedown($('.overlay'));
    expect($('.modal-guard')).not.toBeNull();
    click($('.modal-guard-btns .pa.dark'));
    expect($('.modal-guard')).toBeNull();
    click($('.modal .close'));
    click($('.modal-guard-btns .pa.danger'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('arama kutusuna yazmak yazı sayılmaz', () => {
    const onClose = dialog();
    type($('#q'), 'kargo');
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty açıkça verilirse kendiliğinden izleme yerine o kullanılır', () => {
    const onClose = dialog({ dirty: false });
    type($('#f'), 'x');
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    const onClose2 = dialog({ dirty: true });
    esc();
    expect(onClose2).not.toHaveBeenCalled();
    expect($('.modal-guard')).not.toBeNull();
  });

  it('guard={false} soru sormaz', () => {
    const onClose = dialog({ guard: false });
    type($('#f'), 'x');
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('busy iken Esc, örtü ve X yok sayılır; X kapalı ve nedenini söyler', () => {
    const onClose = dialog({ busy: true, dirty: true });
    esc();
    mousedown($('.overlay'));
    const x = $('.modal .close') as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    expect(x.getAttribute('title')).toBe('modalGuard.busy');
    expect(onClose).not.toHaveBeenCalled();
    expect($('.modal-guard')).toBeNull();
  });

  it('className pencereye eklenir', () => {
    dialog({ className: 'edit-dialog', size: 'wide' });
    expect($('[role="dialog"]')!.className).toBe('modal wide edit-dialog');
  });
});

function slide(props: Partial<Parameters<typeof SlideOver>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <SlideOver title="Davet" onClose={onClose} actions={<button type="button" className="btn">Gönder</button>} {...props}>
      <input id="f" className="inp" />
    </SlideOver>,
  );
  return onClose;
}

describe('SlideOver koruması (Modal ile aynı)', () => {
  const x = () => $('.sod-slide-head button') as HTMLButtonElement;

  it('yazılmadıysa Esc, örtü ve X hemen kapatır', () => {
    const onClose = slide();
    esc();
    mousedown($('.sod-slide-scrim'));
    click(x());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect($('.modal-guard')).toBeNull();
  });

  it('yazıldıysa Esc, örtü ve X sorar; şerit alt satırda eylemlerin yerine çıkar', () => {
    const onClose = slide();
    type($('#f'), 'Ayşe');
    for (const close of [esc, () => mousedown($('.sod-slide-scrim')), () => click(x())]) {
      close();
      expect(onClose).not.toHaveBeenCalled();
      const strip = $('.sod-slide-foot.modal-guard')!;
      expect(strip.getAttribute('role')).toBe('alert');
      expect($$('.sod-slide-foot')).toHaveLength(1); // çağıranın eylemleri gizli
      expect(document.activeElement).toBe($('.modal-guard-btns .pa.dark'));
      click($('.modal-guard-btns .pa.dark'));
      expect($('.modal-guard')).toBeNull();
    }
    click(x());
    click($('.modal-guard-btns .pa.danger'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guard={false} sormaz; busy iken kapanmaz, X kapalı', () => {
    const onClose = slide({ guard: false });
    type($('#f'), 'x');
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(host);
    const onBusy = slide({ busy: true });
    esc();
    mousedown($('.sod-slide-scrim'));
    expect(x().disabled).toBe(true);
    expect(onBusy).not.toHaveBeenCalled();
  });
});

describe('Toast', () => {
  const ui = (props: Partial<Parameters<typeof ToastProvider>[0]> = {}) => render(<ToastProvider {...props}>{null}</ToastProvider>);

  it('hata bildirimi role=alert taşır, diğerleri taşımaz', () => {
    ui();
    act(() => {
      toast.err('Kaydedilemedi', 'Bağlantı yok');
      toast.ok('Kaydedildi');
    });
    expect($('.toast.err')!.getAttribute('role')).toBe('alert');
    expect($('.toast.ok')!.getAttribute('role')).toBeNull();
    expect($('.toasts')!.getAttribute('role')).toBe('status');
  });

  it('info seçenekleri düşmez: eylem düğmesi çıkar ve çalışır', () => {
    ui();
    const onClick = vi.fn();
    act(() => toast.info('Kişi çıkarıldı', undefined, { action: { label: 'Geri al', onClick } }));
    const btn = $('.toast.info .toast-action')!;
    expect(btn.textContent).toBe('Geri al');
    click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect($('.toast')).toBeNull();
  });

  it('info süresi de seçenekten okunur', () => {
    vi.useFakeTimers();
    try {
      ui();
      act(() => toast.info('Bilgi', undefined, { duration: 100 }));
      expect($('.toast.info')).not.toBeNull();
      act(() => vi.advanceTimersByTime(150));
      expect($('.toast.info')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppress true dönerse hata bildirimi susar; always ve diğer türler geçer', () => {
    let lost = true;
    ui({ suppress: () => lost });
    act(() => {
      toast.err('Oturum yok');
      toast.ok('Kaydedildi');
    });
    expect($('.toast.err')).toBeNull();
    expect($('.toast.ok')).not.toBeNull();
    act(() => toast.err('Çıkış yapılamadı', undefined, { always: true }));
    expect($('.toast.err')!.textContent).toContain('Çıkış yapılamadı');
    lost = false;
    act(() => toast.err('Kaydedilemedi'));
    expect($$('.toast.err')).toHaveLength(2);
  });

  it('bant durumu (bağlantı yok) hatayı yine susturur', () => {
    ui();
    const before = sessionStatus.get();
    sessionStatus.update({ offline: true });
    try {
      act(() => toast.err('Kaydedilemedi'));
      expect($('.toast.err')).toBeNull();
    } finally {
      sessionStatus.update(before);
    }
  });

  it('süreler: hata 7 sn, eylemli 8 sn, diğerleri 4 sn; duration önce gelir', () => {
    const action = { label: 'Geri al', onClick: () => undefined };
    expect(toastDuration('err')).toBe(7000);
    expect(toastDuration('err', { action })).toBe(7000);
    expect(toastDuration('ok', { action })).toBe(8000);
    expect(toastDuration('info', { action })).toBe(8000);
    expect(toastDuration('ok')).toBe(4000);
    expect(toastDuration('info', { duration: 1200, action })).toBe(1200);
  });

  it('varsayılan (Merkez): eylemli bildirim alt ortada ayrı yığında, sınıfı toast-action', () => {
    ui();
    act(() => {
      toast.ok('Kaydedildi');
      toast.ok('Rol değişti', undefined, { action: { label: 'Geri al', onClick: () => undefined } });
    });
    expect($$('.toasts')).toHaveLength(2);
    expect($('.toasts.is-bottom .toast')!.textContent).toContain('Rol değişti');
    expect($('.toasts.is-bottom button.toast-action')!.className).toBe('toast-action');
  });

  it('stack (DeciShip): tek yığın, eylem düğmesi eski toast-act sınıfını da taşır', () => {
    ui({ actionPlacement: 'stack' });
    expect($$('.toasts')).toHaveLength(1); // boşken de yerinde
    act(() => {
      toast.ok('Kaydedildi');
      toast.ok('Silindi', undefined, { action: { label: 'Geri al', onClick: () => undefined } });
    });
    expect($$('.toasts')).toHaveLength(1);
    expect($('.toasts.is-bottom')).toBeNull();
    expect($$('.toasts .toast')).toHaveLength(2);
    expect($('.toast .toast-action')!.className).toBe('toast-action toast-act');
  });

  it('varsayılan (Merkez): iki canlı bölge boşken de sayfada (içeriğiyle doğan bölge okunmaz)', () => {
    ui();
    const live = $$('.toasts');
    expect(live).toHaveLength(2);
    expect(live.every((n) => n.getAttribute('role') === 'status' && n.getAttribute('aria-live') === 'polite')).toBe(true);
    act(() => toast.ok('Davet gönderildi'));
    expect($$('.toasts')[0]).toBe(live[0]);
    expect(live[0]!.textContent).toContain('Davet gönderildi');
  });

  it('fare üstündeyken ve odak içindeyken süre durur, bırakınca kalan süre sürer', () => {
    vi.useFakeTimers();
    try {
      ui();
      act(() => toast.info('Kişi çıkarıldı', undefined, { action: { label: 'Geri al', onClick: () => undefined } }));
      const box = $('.toasts.is-bottom')!;
      act(() => vi.advanceTimersByTime(5000));
      act(() => void box.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
      act(() => void box.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })));
      act(() => vi.advanceTimersByTime(20000));
      expect($('.toast.info')).not.toBeNull();
      act(() => void box.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
      act(() => void box.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })));
      act(() => vi.advanceTimersByTime(2000));
      expect($('.toast.info')).not.toBeNull();
      // Klavye: odak "Geri al"dayken de durur.
      act(() => $('.toast.info .toast-action')!.focus());
      act(() => vi.advanceTimersByTime(20000));
      expect($('.toast.info')).not.toBeNull();
      act(() => $('.toast.info .toast-action')!.blur());
      act(() => vi.advanceTimersByTime(1100));
      expect($('.toast.info')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Field', () => {
  it('hata satırı alana bağlanır (aria-describedby); hata gidince bağ kalkar', () => {
    const ui = (error: string | null) =>
      render(
        <Field label="Gönderim tarihi" htmlFor="ds-on" error={error}>
          <input id="ds-on" className="inp" />
        </Field>,
      );
    ui('Bu alan gerekli');
    const input = $('#ds-on')!;
    const err = $('.fld .err')!;
    expect(err.id).not.toBe('');
    expect(input.getAttribute('aria-describedby')).toBe(err.id);
    ui(null);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('yardım satırı da bağlanır; alan çocuğun içinde olabilir, alanın kendi açıklaması korunur', () => {
    render(
      <Field label="Takip no" htmlFor="mq" help="En az 3 karakter">
        <div className="search">
          <input id="mq" aria-describedby="kendi" />
        </div>
      </Field>,
    );
    const help = $('.fld .help')!;
    expect($('#mq')!.getAttribute('aria-describedby')).toBe(`kendi ${help.id}`);
    expect($('#mq')!.hasAttribute('aria-invalid')).toBe(false);
  });

  it('zorunlu alan (req) aria-required taşır; required özniteliği olan alana eklenmez', () => {
    render(
      <>
        <Field label="Neden" htmlFor="dx-reason" className="req">
          <textarea id="dx-reason" />
        </Field>
        <Field label="Ad" htmlFor="ad" className="req">
          <input id="ad" required />
        </Field>
        <Field label="Not" htmlFor="not">
          <input id="not" />
        </Field>
      </>,
    );
    expect($('#dx-reason')!.getAttribute('aria-required')).toBe('true');
    expect($('#ad')!.hasAttribute('aria-required')).toBe(false);
    expect($('#not')!.hasAttribute('aria-required')).toBe(false);
  });

  it('aria-invalid eklenmez: [aria-invalid] kırmızı çerçeve çizer, görünüm çağıranın kararı; çağıranın değeri korunur', () => {
    render(
      <>
        <Field label="Kenar toleransı" htmlFor="s-edge" error="Gerekli">
          <input id="s-edge" className="inp" />
        </Field>
        <Field label="Tarih" htmlFor="d" error="Geçersiz">
          <input id="d" className="inp" aria-invalid="true" />
        </Field>
      </>,
    );
    expect($('#s-edge')!.hasAttribute('aria-invalid')).toBe(false);
    expect($('#d')!.getAttribute('aria-invalid')).toBe('true');
    expect($('#d')!.getAttribute('aria-describedby')).toBe($$('.fld .err')[1]!.id);
  });
});

describe('Sekmeler (tabListKeyDown, tabStop)', () => {
  function Tabs({ onPick }: { onPick: (i: number) => void }) {
    return (
      <div role="tablist" aria-label="Durum" onKeyDown={tabListKeyDown}>
        {['Tümü', 'Gönderilmedi', 'Kapalı', 'Gönderildi'].map((x, i) => (
          <button key={x} type="button" role="tab" aria-selected={i === 0} tabIndex={tabStop(i, 0)} disabled={x === 'Kapalı'} onClick={() => onPick(i)}>
            {x}
          </button>
        ))}
      </div>
    );
  }
  const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

  it('ok tuşları komşu sekmeye geçer ve seçer; kapalı sekme atlanır; Home/End uçlara', () => {
    const onPick = vi.fn();
    render(<Tabs onPick={onPick} />);
    const tabs = $$('[role="tab"]');
    act(() => tabs[0]!.focus());
    key(tabs[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    key(tabs[1]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[3]);
    key(tabs[3]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0]!, 'ArrowLeft');
    expect(document.activeElement).toBe(tabs[3]);
    key(tabs[3]!, 'Home');
    expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0]!, 'End');
    expect(document.activeElement).toBe(tabs[3]);
    expect(onPick.mock.calls.map((c: number[]) => c[0])).toEqual([1, 3, 0, 3, 0, 3]);
    key(tabs[3]!, 'a');
    expect(onPick).toHaveBeenCalledTimes(6);
  });

  it('tabStop: Tab listeye seçili sekmeden girer, seçili yoksa ilkinden', () => {
    expect([0, 1, 2].map((i) => tabStop(i, 1))).toEqual([-1, 0, -1]);
    expect([0, 1, 2].map((i) => tabStop(i, -1))).toEqual([0, -1, -1]);
  });
});

describe('errorText', () => {
  it('ApiError adını taşıyan her hata tanınır (uygulamanın kendi sınıfı da)', () => {
    class OtherApiError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ApiError';
      }
    }
    expect(errorText(new ApiError(400, 'X', 'Kabuk nedeni'), 'genel')).toBe('Kabuk nedeni');
    expect(errorText(new OtherApiError('Panel nedeni'), 'genel')).toBe('Panel nedeni');
    expect(errorText(new OtherApiError(''), 'genel')).toBe('genel');
    expect(errorText(new Error('iç ayrıntı'), 'genel')).toBe('genel');
    expect(errorText(null, 'genel')).toBe('genel');
  });
});

describe('ActionMenu', () => {
  const items = (fn = vi.fn()) => [
    { label: 'Birinci', onSelect: fn },
    { label: 'İkinci', onSelect: fn },
    { label: 'Üçüncü', onSelect: fn, danger: true },
  ];

  it('varsayılan: liste body’ye çizilir, ⋯ düğmesi icon-btn', () => {
    render(<ActionMenu iconOnly label="İşlemler" items={items()} />);
    const trigger = $('.amenu > button')!;
    expect(trigger.className).toBe('icon-btn');
    expect(trigger.querySelector('svg')!.getAttribute('data-i')).toBe('dots');
    click(trigger);
    const list = $('.amenu-list')!;
    expect(list.parentElement).toBe(document.body);
    expect(list.querySelector('.danger .amenu-text')!.textContent).toBe('Üçüncü');
  });

  it('portal={false}: liste düğmenin hemen ardında, satır içi; DeciShip ⋯ biçimi', () => {
    render(<ActionMenu iconOnly portal={false} dotsTrigger="button" dotsIcon="dotsnarrow" items={items()} />);
    const trigger = $('.amenu > button')!;
    expect(trigger.className).toBe('btn btn-secondary btn-icon amenu-dots');
    expect(trigger.getAttribute('aria-label')).toBe('common.more');
    expect(trigger.querySelector('svg')!.getAttribute('data-i')).toBe('dotsnarrow');
    click(trigger);
    const list = $('.amenu-list')!;
    expect(list.previousElementSibling).toBe(trigger);
    expect(list.getAttribute('style')).toBeNull();
    expect(document.activeElement!.textContent).toBe('Birinci');
  });

  it('disabled ve busy düğmeyi kapatır', () => {
    render(<ActionMenu label="Diğer" disabled items={items()} />);
    expect(($('.amenu > button') as HTMLButtonElement).disabled).toBe(true);
    render(<ActionMenu label="Diğer" busy items={items()} />);
    const b = $('.amenu > button') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.querySelector('svg')!.getAttribute('data-i')).toBe('spin');
  });

  it('başlık satırı ve küçük liste: tehlikeli öğeden önce ayraç, listenin adı düğmenin adı', () => {
    render(<ActionMenu iconOnly compact label="Depo şefi için işlemler" header={<b>Depo şefi</b>} items={items()} />);
    click($('.amenu > button'));
    const list = $('.amenu-list')!;
    expect(list.className).toBe('amenu-list compact');
    expect(list.getAttribute('aria-label')).toBe('Depo şefi için işlemler');
    expect(list.firstElementChild!.className).toBe('amenu-head');
    expect(list.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    const sep = list.querySelector('.amenu-sep')!;
    expect(sep.nextElementSibling!.textContent).toBe('Üçüncü');
    expect(list.querySelectorAll('.amenu-sep').length).toBe(1);
    // Başlık seçilemez: ilk odak ilk öğede.
    expect(document.activeElement!.textContent).toBe('Birinci');
  });

  it('ekranın dibindeki düğmede liste yukarı açılır, sağ kenarda sola kayar (ekran dışına taşmaz)', () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const restore = ['offsetWidth', 'scrollHeight'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 220 });
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 180 });
    try {
      render(<ActionMenu iconOnly align="left" label="İşlemler" items={items()} />);
      const trigger = $('.amenu > button')!;
      const h = window.innerHeight;
      const w = document.documentElement.clientWidth || window.innerWidth;
      trigger.getBoundingClientRect = () => ({ top: h - 40, bottom: h - 4, left: w - 30, right: w - 4, width: 26, height: 36, x: w - 30, y: h - 40, toJSON: () => ({}) }) as DOMRect;
      click(trigger);
      const list = $('.amenu-list')!;
      const top = parseFloat(list.style.top);
      const left = parseFloat(list.style.left);
      expect(top).toBe(h - 40 - 4 - 180);
      expect(top + 180).toBeLessThanOrEqual(h);
      expect(left + 220).toBeLessThanOrEqual(w - 8);
      expect(list.style.right).toBe('auto');
    } finally {
      for (const [k, d] of restore) {
        if (d) Object.defineProperty(proto, k, d);
        else delete proto[k];
      }
    }
  });

  for (const portal of [true, false]) {
    it(`↓ her basışta bir öğe ilerler (portal=${portal})`, () => {
      render(<ActionMenu label="Diğer" portal={portal} items={items()} />);
      click($('.amenu > button'));
      expect(document.activeElement!.textContent).toBe('Birinci');
      act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
      expect(document.activeElement!.textContent).toBe('İkinci');
    });
  }
});

describe('Pager', () => {
  it('birim verilirse metinde o kullanılır', () => {
    render(<Pager page={2} pageSize={20} total={45} onPage={() => undefined} label="fatura" />);
    expect($('.tfoot > .muted')!.textContent).toBe('common.rangeOfUnit:{"from":21,"to":40,"total":45,"label":"fatura"}');
    render(<Pager page={1} pageSize={20} total={0} onPage={() => undefined} />);
    expect($('.tfoot > .muted')!.textContent).toBe('common.rangeOf:{"from":0,"to":0,"total":0}');
  });
});

describe('rowProps', () => {
  const key = (el: HTMLElement, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
  const table = (onActivate: () => void) =>
    render(
      <table>
        <tbody>
          <tr {...rowProps(onActivate, true)} data-testid="row">
            <td>
              <button type="button">Ayrı düğme</button>
            </td>
          </tr>
        </tbody>
      </table>,
    );

  it('satırın kendisinde Enter ve boşluk satırı açar, tıklama da açar', () => {
    const open = vi.fn();
    table(open);
    key($('tr')!, 'Enter');
    key($('tr')!, ' ');
    click($('tr'));
    expect(open).toHaveBeenCalledTimes(3);
  });
  it('satırın içindeki düğmeden gelen Enter ve boşluk satırı açmaz', () => {
    const open = vi.fn();
    table(open);
    key($('button')!, 'Enter');
    key($('button')!, ' ');
    expect(open).not.toHaveBeenCalled();
  });
  it('aria-selected yazılmaz (satır bir ızgara değil); seçili satır yalnız sınıfla belli olur', () => {
    table(() => undefined);
    expect($('tr')!.hasAttribute('aria-selected')).toBe(false);
    expect($('tr')!.className).toBe('clickable sel');
  });
});
