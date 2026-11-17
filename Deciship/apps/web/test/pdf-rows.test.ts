// Y23: elle eklenen PDF satırının no'su okunan satırlarla çakışmaz.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextPdfRowIndex } from '../src/pages/invoice-upload/pdfRows.ts';

describe('elle eklenen PDF satırı', () => {
  it('boş listede 0, yoksa en büyük no + 1', () => {
    assert.equal(nextPdfRowIndex([]), 0);
    assert.equal(nextPdfRowIndex([{ rowIndex: 0 }, { rowIndex: 2 }, { rowIndex: 1 }]), 3);
  });

  it('10.000+ satırlı okumada da çakışmaz (eski sabit taban 10000 idi)', () => {
    const rows = Array.from({ length: 12000 }, (_, i) => ({ rowIndex: i }));
    const next = nextPdfRowIndex(rows);
    assert.equal(next, 12000);
    assert.equal(rows.some((r) => r.rowIndex === next), false);
    // art arda iki ekleme
    assert.equal(nextPdfRowIndex([...rows, { rowIndex: next }]), 12001);
  });
});
