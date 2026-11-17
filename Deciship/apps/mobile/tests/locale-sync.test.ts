import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Locale } from '@sellerondata/contracts';
import { createLocaleSync, isPermanentLocaleError } from '../src/auth/localeSync';

function setup(person: string | null = 'ayse') {
  const box = new Map<string, Locale>();
  const send = vi.fn(async (_locale: Locale) => undefined);
  const onSynced = vi.fn();
  let current = person;
  const sync = createLocaleSync({
    read: async (personId) => box.get(personId) ?? null,
    write: async (personId, locale) => {
      if (locale) box.set(personId, locale);
      else box.delete(personId);
    },
    send,
    currentPerson: () => current,
    isPermanent: isPermanentLocaleError,
    onSynced,
  });
  return { box, send, sync, onSynced, setPerson: (p: string | null) => (current = p) };
}

describe('dil seçimi eşitleme', () => {
  it('çevrimiçi: sunucuya yazılır, bekleyen temizlenir', async () => {
    const { box, send, sync, onSynced } = setup();
    await expect(sync.choose('ayse', 'en')).resolves.toBe('synced');
    expect(send).toHaveBeenCalledWith('en');
    expect(box.size).toBe(0);
    expect(onSynced).toHaveBeenCalledWith('ayse', 'en');
  });

  it('çevrimdışı: seçim yerelde kalır, sunucudan gelen eski dil onu ezmez', async () => {
    const { box, send, sync } = setup();
    send.mockRejectedValue({ status: 0, code: 'NETWORK' });
    await expect(sync.choose('ayse', 'en')).resolves.toBe('pending');
    expect(box.get('ayse')).toBe('en');
    await expect(sync.effective('ayse', 'tr')).resolves.toBe('en');
  });

  it('bağlantı gelince eşitlenir, sonra sunucu dili geçerli olur', async () => {
    const { box, send, sync } = setup();
    send.mockRejectedValueOnce({ status: 0, code: 'NETWORK' });
    await sync.choose('ayse', 'en');
    await expect(sync.flush('ayse')).resolves.toBe('synced');
    expect(send).toHaveBeenLastCalledWith('en');
    expect(box.size).toBe(0);
    await expect(sync.effective('ayse', 'tr')).resolves.toBe('tr');
  });

  it('kapanıp açılınca bekleyen seçim korunur', async () => {
    const box = new Map<string, Locale>([['ayse', 'en']]);
    const send = vi.fn(async () => undefined);
    const again = createLocaleSync({
      read: async (p) => box.get(p) ?? null,
      write: async (p, l) => void (l ? box.set(p, l) : box.delete(p)),
      send,
      currentPerson: () => 'ayse',
      isPermanent: isPermanentLocaleError,
    });
    await expect(again.effective('ayse', 'tr')).resolves.toBe('en');
    await again.flush('ayse');
    expect(send).toHaveBeenCalledWith('en');
  });

  it('sunucu 5xx, 429 ve 401: seçim silinmez', async () => {
    for (const status of [401, 408, 429, 500, 503]) {
      const { box, send, sync } = setup();
      send.mockRejectedValue({ status, code: 'X' });
      await expect(sync.choose('ayse', 'en')).resolves.toBe('pending');
      expect(box.get('ayse')).toBe('en');
    }
  });

  it('sunucu reddederse seçim düşer, sonsuza dek denenmez', async () => {
    const { box, send, sync } = setup();
    send.mockRejectedValue({ status: 400, code: 'VALIDATION' });
    await expect(sync.choose('ayse', 'en')).resolves.toBe('rejected');
    expect(box.size).toBe(0);
    await expect(sync.effective('ayse', 'tr')).resolves.toBe('tr');
  });

  it('başka kişinin oturumunda gönderilmez, seçimi de ona uygulanmaz', async () => {
    const { send, sync, setPerson } = setup('ayse');
    send.mockRejectedValueOnce({ status: 0, code: 'NETWORK' });
    await sync.choose('ayse', 'en');
    setPerson('mehmet');
    send.mockClear();
    await expect(sync.flush('ayse')).resolves.toBe('pending');
    await expect(sync.flush('mehmet')).resolves.toBe('none');
    expect(send).not.toHaveBeenCalled();
    await expect(sync.effective('mehmet', 'tr')).resolves.toBe('tr');
  });

  it('oturum yokken gönderilmez', async () => {
    const { send, sync, setPerson } = setup('ayse');
    setPerson(null);
    await expect(sync.choose('ayse', 'en')).resolves.toBe('pending');
    expect(send).not.toHaveBeenCalled();
  });

  it('art arda seçimde son seçim kazanır, yarışan yanıt onu silmez', async () => {
    const { box, send, sync } = setup();
    let release: () => void = () => undefined;
    send.mockImplementationOnce(() => new Promise<undefined>((r) => (release = () => r(undefined))));
    const first = sync.choose('ayse', 'en');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = sync.choose('ayse', 'tr');
    release();
    await Promise.all([first, second]);
    expect(send).toHaveBeenLastCalledWith('tr');
    expect(box.size).toBe(0);
  });
});

describe('bağlantılar', () => {
  it('AuthContext sunucu dilini doğrudan uygulamaz, bekleyen seçime bakar', () => {
    const src = readFileSync('src/auth/AuthContext.tsx', 'utf8');
    expect(src).not.toMatch(/setLocale\((m|cached)\.person\.locale\)/);
    expect(src).toContain('localeSync.effective(');
    expect(src).toContain("'/me', { method: 'PATCH', json: { locale }");
  });

  it('seçimden önce başlamış profil okuması eski dili geri getirmez', () => {
    const src = readFileSync('src/auth/AuthContext.tsx', 'utf8');
    expect(src).toContain('changesAtStart === localeChanges.current');
    expect(src).toContain('localeChanges.current += 1');
  });

  it('Hesap ekranında dil seçici var', () => {
    // Hesap ekranı Merkez'de ve DeciShip içinde aynı bileşen.
    expect(readFileSync('src/screens/AccountScreen.tsx', 'utf8')).toContain('<LangPicker');
    for (const route of ['app/(tabs)/account.tsx', 'app/(tabs)/deciship/account.tsx']) expect(readFileSync(route, 'utf8')).toContain('src/screens/AccountScreen');
  });
});
