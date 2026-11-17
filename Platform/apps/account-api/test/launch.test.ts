import { afterEach, describe, expect, it } from 'vitest';
import { PRODUCT_KEYS, PRODUCTS } from '@sellerondata/contracts';
import {
  PRODUCT_LAUNCH_ENV,
  assertLaunchConfig,
  isProductOn,
  launchOverrides,
  parseProductLaunch,
  productLaunch,
  productLaunches,
} from '../src/lib/launch.ts';

const saved = process.env[PRODUCT_LAUNCH_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[PRODUCT_LAUNCH_ENV];
  else process.env[PRODUCT_LAUNCH_ENV] = saved;
});

describe('parseProductLaunch', () => {
  it('bos ve tanimsiz deger bos eslem', () => {
    expect(parseProductLaunch(undefined).size).toBe(0);
    expect(parseProductLaunch('').size).toBe(0);
    expect(parseProductLaunch(' , ,').size).toBe(0);
  });

  it('urun=durum ciftlerini bosluklari kirparak okur', () => {
    const m = parseProductLaunch(' orderloom = pilot , tagpress=off,deciship=public ');
    expect([...m]).toEqual([
      ['orderloom', 'pilot'],
      ['tagpress', 'off'],
      ['deciship', 'public'],
    ]);
  });

  it('bilinmeyen urun, bilinmeyen durum, eksik esittir ve tekrar hata verir', () => {
    expect(() => parseProductLaunch('ornekarac=pilot')).toThrow(/bilinmeyen ürün/);
    expect(() => parseProductLaunch('DeciShip=public')).toThrow(/bilinmeyen ürün/);
    expect(() => parseProductLaunch('deciship=beta')).toThrow(/bilinmeyen durum/);
    expect(() => parseProductLaunch('deciship=PUBLIC')).toThrow(/bilinmeyen durum/);
    expect(() => parseProductLaunch('deciship=')).toThrow(/bilinmeyen durum/);
    expect(() => parseProductLaunch('deciship')).toThrow(/beklenen urun=durum/);
    expect(() => parseProductLaunch('=off')).toThrow(/beklenen urun=durum/);
    expect(() => parseProductLaunch('deciship=off,deciship=public')).toThrow(/iki kez/);
  });
});

describe('productLaunch ve isProductOn', () => {
  it('ortam yoksa kayit gecerli', () => {
    delete process.env[PRODUCT_LAUNCH_ENV];
    for (const k of PRODUCT_KEYS) expect(productLaunch(k)).toBe(PRODUCTS[k].launch);
    expect(productLaunch('deciship')).toBe('public');
    expect(isProductOn('deciship')).toBe(true);
    expect(isProductOn('orderloom')).toBe(false);
    expect(isProductOn('tagpress')).toBe(false);
  });

  it('ortam kaydi ezer ve her okumada yeniden okunur', () => {
    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=off';
    expect(productLaunch('deciship')).toBe('off');
    expect(isProductOn('deciship')).toBe(false);
    expect(productLaunch('orderloom')).toBe('off');

    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=pilot';
    expect(productLaunch('deciship')).toBe('pilot');
    expect(isProductOn('deciship')).toBe(true);

    delete process.env[PRODUCT_LAUNCH_ENV];
    expect(productLaunch('deciship')).toBe('public');
  });

  it('acik verilen ezme ortamdan bagimsiz', () => {
    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=off';
    const overrides = parseProductLaunch('orderloom=pilot');
    expect(productLaunch('deciship', overrides)).toBe('public');
    expect(isProductOn('orderloom', overrides)).toBe(true);
    expect(productLaunches(overrides)).toEqual({ deciship: 'public', orderloom: 'pilot', tagpress: 'off' });
    expect(productLaunches()).toEqual({ deciship: 'off', orderloom: 'off', tagpress: 'off' });
  });

  it('ortamdaki bicim hatasi okumada atar', () => {
    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=acik';
    expect(() => launchOverrides()).toThrow(/bilinmeyen durum/);
    expect(() => isProductOn('deciship')).toThrow(/bilinmeyen durum/);
  });
});

describe('assertLaunchConfig', () => {
  it('bos ayar ve bugunku kayit gecerli, uyari yok', () => {
    expect(assertLaunchConfig(undefined)).toEqual({ warnings: [] });
    expect(assertLaunchConfig('')).toEqual({ warnings: [] });
    expect(assertLaunchConfig('deciship=pilot,orderloom=off,tagpress=off')).toEqual({ warnings: [] });
  });

  it('varsayilan deger ortamdan', () => {
    process.env[PRODUCT_LAUNCH_ENV] = 'tagpress=public';
    expect(() => assertLaunchConfig()).toThrow(/tagpress/);
    delete process.env[PRODUCT_LAUNCH_ENV];
    expect(assertLaunchConfig()).toEqual({ warnings: [] });
  });

  it('rolu, sahip rolu ve deploy.api olmayan urunu acmak hata', () => {
    for (const launch of ['pilot', 'public']) {
      let message = '';
      try {
        assertLaunchConfig(`orderloom=${launch}`);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/orderloom: .*rol yok/);
      expect(message).toMatch(/sahip rolü yok/);
      expect(message).toMatch(/deploy\.api yok/);
    }
  });

  it('bicim hatasi hata', () => {
    expect(() => assertLaunchConfig('ornekarac=pilot')).toThrow(/bilinmeyen ürün/);
    expect(() => assertLaunchConfig('deciship=beta')).toThrow(/bilinmeyen durum/);
  });

  it('public urunu off yapmak hata degil, uyari', () => {
    const { warnings } = assertLaunchConfig('deciship=off');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^deciship kayıtta public/);
    expect(assertLaunchConfig('orderloom=off').warnings).toEqual([]);
  });
});
