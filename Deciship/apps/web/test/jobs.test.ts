// Mesaj 7: arka plan işi yardımcıları (durum, yüzde, süre, yoklama aralığı, aşama anahtarı) ve sözlük eşitliği.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
  JOB_STAGES,
  creepPercent,
  formatElapsed,
  isJobFinished,
  isJobStarted,
  jobElapsedMs,
  jobPercent,
  jobPhase,
  jobPollMs,
  jobStageKey,
} from '../src/lib/jobs.ts';

const locale = (lang: string, file: string) => JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}/${file}.json`, import.meta.url), 'utf8')) as Record<string, any>;

describe('isJobFinished', () => {
  it('bitmiş üç durum', () => {
    for (const s of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) assert.equal(isJobFinished(s), true);
  });
  it('kuyrukta ve çalışan iş bitmemiştir', () => {
    for (const s of ['QUEUED', 'RUNNING'] as const) assert.equal(isJobFinished(s), false);
  });
});

describe('jobPhase', () => {
  it('durum → hâl', () => {
    assert.equal(jobPhase({ status: 'QUEUED', cancelRequested: false }), 'queued');
    assert.equal(jobPhase({ status: 'RUNNING', cancelRequested: false }), 'running');
    assert.equal(jobPhase({ status: 'SUCCEEDED', cancelRequested: false }), 'succeeded');
    assert.equal(jobPhase({ status: 'FAILED', cancelRequested: false }), 'failed');
    assert.equal(jobPhase({ status: 'CANCELLED', cancelRequested: true }), 'stopped');
  });
  it('durdurma istenmiş ama bitmemiş iş "durduruluyor" sayılır', () => {
    assert.equal(jobPhase({ status: 'RUNNING', cancelRequested: true }), 'stopping');
    assert.equal(jobPhase({ status: 'QUEUED', cancelRequested: true }), 'stopping');
  });
});

describe('jobPercent', () => {
  it('toplam biliniyorsa yüzde', () => {
    assert.equal(jobPercent({ done: 12, total: 48 }), 25);
    assert.equal(jobPercent({ done: 48, total: 48 }), 100);
    assert.equal(jobPercent({ done: 0, total: 10 }), 0);
  });
  it('toplam yok ya da sıfırsa null (yavaş ilerleyen çubuk)', () => {
    assert.equal(jobPercent({ done: 3, total: null }), null);
    assert.equal(jobPercent({ done: 0, total: 0 }), null);
  });
  it('aşan ya da eksi değer sınırlanır', () => {
    assert.equal(jobPercent({ done: 60, total: 48 }), 100);
    assert.equal(jobPercent({ done: -5, total: 48 }), 0);
  });
});

describe('creepPercent', () => {
  it('hiçbir zaman 96 yı geçmez, artar', () => {
    assert.equal(creepPercent(0), 0);
    assert.ok(creepPercent(10) > 0 && creepPercent(10) < creepPercent(40));
    assert.equal(creepPercent(100000), 96);
  });
});

describe('jobElapsedMs', () => {
  it('çalışan işte sunucu süresine yoklamadan beri geçen eklenir', () => {
    assert.equal(jobElapsedMs({ status: 'RUNNING', elapsedMs: 5000 }, 1000, 3500), 7500);
  });
  it('bitmiş işte sunucu değeri değişmez', () => {
    assert.equal(jobElapsedMs({ status: 'SUCCEEDED', elapsedMs: 5000 }, 1000, 99999), 5000);
  });
  it('saat geriye giderse eksiye düşmez', () => {
    assert.equal(jobElapsedMs({ status: 'RUNNING', elapsedMs: 5000 }, 2000, 1000), 5000);
  });
});

describe('formatElapsed', () => {
  it('d:ss', () => {
    assert.equal(formatElapsed(0), '0:00');
    assert.equal(formatElapsed(7400), '0:07');
    assert.equal(formatElapsed(155000), '2:35');
    assert.equal(formatElapsed(-1), '0:00');
  });
});

describe('jobPollMs', () => {
  it('ilk 10 saniye 1 sn, sonra 2 sn', () => {
    assert.equal(jobPollMs(0), 1000);
    assert.equal(jobPollMs(9999), 1000);
    assert.equal(jobPollMs(10000), 2000);
    assert.equal(jobPollMs(120000), 2000);
  });
  it('sayfa gizliyken seyrek', () => {
    assert.equal(jobPollMs(0, true), 10000);
    assert.equal(jobPollMs(60000, true), 10000);
  });
});

describe('jobStageKey', () => {
  it('bilinen aşama → common:jobs.stage anahtarı', () => {
    assert.equal(jobStageKey('pdfRead'), 'jobs.stage.pdfRead');
    assert.equal(jobStageKey('bulkWrite'), 'jobs.stage.bulkWrite');
  });
  it('bilinmeyen ya da boş aşama → null', () => {
    assert.equal(jobStageKey('uzayGemisi'), null);
    assert.equal(jobStageKey(null), null);
    assert.equal(jobStageKey(undefined), null);
  });
  it('her aşamanın TR ve EN metni var', () => {
    for (const lang of ['tr', 'en']) {
      const stage = locale(lang, 'common').jobs.stage as Record<string, string>;
      for (const s of JOB_STAGES) assert.ok(stage[s], `${lang} jobs.stage.${s}`);
    }
  });
});

describe('isJobStarted', () => {
  const job = { id: 'j1', status: 'QUEUED' };
  it('202 yanıtı { job, joined }', () => {
    assert.equal(isJobStarted({ job, joined: false }), true);
    assert.equal(isJobStarted({ jobId: 'j1', status: 'QUEUED', job, joined: true }), true);
  });
  it('eşzamanlı önizleme gövdesi iş sayılmaz', () => {
    assert.equal(isJobStarted({ fileId: 'f1', format: 'pdf', aiLines: [] }), false);
    assert.equal(isJobStarted(null), false);
    assert.equal(isJobStarted('x'), false);
  });
});

describe('sözlük', () => {
  it('jobs anahtarları TR ve EN aynı, boş yok', () => {
    const keys = (o: Record<string, any>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    const tr = keys(locale('tr', 'common').jobs);
    const en = keys(locale('en', 'common').jobs);
    assert.deepEqual(tr.sort(), en.sort());
    for (const k of ['queued', 'running', 'elapsed', 'step', 'stop', 'stopping', 'background', 'resumed', 'failed', 'stopped']) assert.ok(tr.includes(k), k);
  });
  it('fatura ve tarife ekranı metinleri iki dilde var', () => {
    for (const lang of ['tr', 'en']) {
      assert.ok(locale(lang, 'invoiceUpload').one.pdfQueued);
      assert.ok(locale(lang, 'invoiceUpload').one.pdfBackground);
      assert.ok(locale(lang, 'tariffImport').pdf.queued);
    }
  });
});
