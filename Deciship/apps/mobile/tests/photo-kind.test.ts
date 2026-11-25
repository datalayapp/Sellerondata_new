import { describe, expect, it } from 'vitest';
import { photoKindFor } from '../src/lib/photoKind';

describe('photoKindFor (galeri fotoğrafı koli kanıtı sayılmaz)', () => {
  it('kamera çekimi koli fotoğrafıdır', () => {
    expect(photoKindFor('camera')).toBe('PHOTO_BOX');
  });

  it('galeriden seçilen fotoğraf "diğer fotoğraf" olur', () => {
    expect(photoKindFor('gallery')).toBe('PHOTO_OTHER');
  });
});
