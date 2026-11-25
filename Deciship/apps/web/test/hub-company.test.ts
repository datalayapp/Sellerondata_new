// Sihirbazdaki firma bilgisi: onay Merkez `/me`'den (yoksa DeciShip kopyasından), "Merkez'de onayla" dönüş adresi.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeResponse } from '@sellerondata/contracts';
import { HUB_COMPANY_PATH, companyConfirmed, companyFacts, countryLabel, hubConfirmHref, timeZoneLabel } from '../src/pages/onboarding/company.ts';

type Org = NonNullable<MeResponse['activeOrg']>;
const org = (over: Partial<Org> = {}): Org => ({ id: 'o1', name: 'Merkez Adı', country: 'TR', currency: 'TRY', orgRole: 'OWNER', membershipId: 'm1', ...over });
const copy = (confirmed: boolean) => ({
  company: { name: 'Kopya Adı', currency: 'EUR', country: 'DE', timeZone: 'Europe/Berlin', confirmed },
});

describe('firma onayı', () => {
  it('Merkez /me varsa ona bakılır, DeciShip kopyası yok sayılır', () => {
    assert.equal(companyConfirmed(org({ companyConfirmedAt: null }), copy(true)), false);
    assert.equal(companyConfirmed(org({ companyConfirmedAt: '2026-11-13T10:00:00.000Z' }), copy(false)), true);
  });
  it('alan yoksa (eski sunucu) onaylı sayılır', () => {
    assert.equal(companyConfirmed(org(), copy(false)), true);
  });
  it('Merkez /me yoksa kopya', () => {
    assert.equal(companyConfirmed(null, copy(false)), false);
    assert.equal(companyConfirmed(undefined, copy(true)), true);
  });
});

describe('gösterilen firma bilgisi', () => {
  it("Merkez'den; eksik alan sihirbaz yanıtından", () => {
    assert.deepEqual(companyFacts(org({ timeZone: 'Europe/Istanbul' }), copy(true).company), {
      name: 'Merkez Adı',
      country: 'TR',
      currency: 'TRY',
      timeZone: 'Europe/Istanbul',
    });
    assert.equal(companyFacts(org(), copy(true).company).timeZone, 'Europe/Berlin');
    assert.equal(companyFacts(null, copy(true).company).name, 'Kopya Adı');
  });
  it('saat dilimi ve ülke okunur yazılır', () => {
    assert.match(timeZoneLabel('Europe/Istanbul'), /^Europe\/Istanbul \(GMT\+3\)$/);
    assert.equal(timeZoneLabel('America/New_York').startsWith('America/New York'), true);
    assert.equal(timeZoneLabel('UTC'), 'UTC');
    assert.equal(timeZoneLabel(''), '');
    assert.equal(countryLabel('TR', 'tr'), 'Türkiye');
    assert.equal(countryLabel('DE', 'en'), 'Germany');
    assert.equal(countryLabel('', 'tr'), '');
  });
});

describe("Merkez'de onayla adresi", () => {
  it('dönüş, sihirbazın tam yoludur (taban yol ve parametreler dahil), kodlanmış ve aynı kökende', () => {
    const href = hubConfirmHref('/setup', '?adim=tarifeler');
    assert.equal(href, `${HUB_COMPANY_PATH}?next=%2Fdeciship%2Fsetup%3Fadim%3Dtarifeler`);
    assert.equal(new URL(href, 'https://app.example').searchParams.get('next'), '/deciship/setup?adim=tarifeler');
  });
  it('parametresiz yol ve soru işaretsiz arama', () => {
    assert.equal(hubConfirmHref('/setup'), '/account/company?next=%2Fdeciship%2Fsetup');
    assert.equal(hubConfirmHref('/setup', 'adim=ozet'), '/account/company?next=%2Fdeciship%2Fsetup%3Fadim%3Dozet');
  });
});
