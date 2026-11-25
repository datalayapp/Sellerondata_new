/**
 * `expo-file-system` (yeni `File` / `Directory` / `Paths` arayüzü) için bellek içi sahte. Yalnız taslak fotoğraflarının
 * kullandığı kısım: var mı, oluştur, sil, listele, kopyala, taşı. Adresler `file:///doc/…` (kalıcı) ve `file:///cache/…` (önbellek).
 * Kullanım: `vi.mock('expo-file-system', async () => (await import('./fakeFs')).fakeFsModule)`.
 */
type Part = string | { uri: string };

const files = new Map<string, string>();
const dirs = new Set<string>();
const state = { failCopy: false };

const trim = (u: string) => u.replace(/\/+$/, '');
const join = (parts: Part[]): string => {
  let base = '';
  for (const p of parts) {
    const s = typeof p === 'string' ? p : p.uri;
    base = base ? `${trim(base)}/${s.replace(/^\/+/, '')}` : s;
  }
  return trim(base);
};
const parentOf = (u: string) => `${trim(u).slice(0, trim(u).lastIndexOf('/'))}/`;
const baseName = (u: string) => trim(u).slice(trim(u).lastIndexOf('/') + 1);

class FakeDirectory {
  uri: string;
  constructor(...parts: Part[]) {
    this.uri = `${join(parts)}/`;
  }
  get exists() {
    return dirs.has(this.uri);
  }
  get name() {
    return baseName(this.uri);
  }
  create(opts: { intermediates?: boolean; idempotent?: boolean } = {}) {
    if (this.exists) {
      if (opts.idempotent) return;
      throw new Error(`exists: ${this.uri}`);
    }
    if (!dirs.has(parentOf(this.uri))) {
      if (!opts.intermediates) throw new Error(`no parent: ${this.uri}`);
      new FakeDirectory(parentOf(this.uri)).create({ intermediates: true, idempotent: true });
    }
    dirs.add(this.uri);
  }
  delete() {
    if (!this.exists) throw new Error(`no dir: ${this.uri}`);
    for (const d of [...dirs]) if (d.startsWith(this.uri)) dirs.delete(d);
    for (const f of [...files.keys()]) if (f.startsWith(this.uri)) files.delete(f);
  }
  list(): (FakeDirectory | FakeFile)[] {
    if (!this.exists) throw new Error(`no dir: ${this.uri}`);
    const out: (FakeDirectory | FakeFile)[] = [];
    for (const d of dirs) if (d !== this.uri && parentOf(d) === this.uri) out.push(new FakeDirectory(d));
    for (const f of files.keys()) if (parentOf(f) === this.uri) out.push(new FakeFile(f));
    return out;
  }
}

class FakeFile {
  uri: string;
  constructor(...parts: Part[]) {
    this.uri = join(parts);
  }
  get exists() {
    return files.has(this.uri);
  }
  get name() {
    return baseName(this.uri);
  }
  delete() {
    if (!this.exists) throw new Error(`no file: ${this.uri}`);
    files.delete(this.uri);
  }
  private target(dest: FakeDirectory | FakeFile) {
    return dest instanceof FakeDirectory ? new FakeFile(dest, this.name) : dest;
  }
  copySync(dest: FakeDirectory | FakeFile, opts: { overwrite?: boolean } = {}) {
    if (state.failCopy) throw new Error('disk full');
    if (!this.exists) throw new Error(`no file: ${this.uri}`);
    const t = this.target(dest);
    if (!dirs.has(parentOf(t.uri))) throw new Error(`no parent: ${t.uri}`);
    if (t.exists && !opts.overwrite) throw new Error(`exists: ${t.uri}`);
    // Android gibi: `overwrite` önce hedefi siler, sonra kaynağı okur (kendi üstüne kopya kaynağı yok eder).
    if (t.exists) files.delete(t.uri);
    if (!files.has(this.uri)) throw new Error(`no file: ${this.uri}`);
    files.set(t.uri, files.get(this.uri)!);
  }
  async copy(dest: FakeDirectory | FakeFile, opts?: { overwrite?: boolean }) {
    this.copySync(dest, opts);
  }
  moveSync(dest: FakeDirectory | FakeFile, opts?: { overwrite?: boolean }) {
    const t = this.target(dest);
    this.copySync(t, opts);
    files.delete(this.uri);
    this.uri = t.uri;
  }
  async move(dest: FakeDirectory | FakeFile, opts?: { overwrite?: boolean }) {
    this.moveSync(dest, opts);
  }
}

export const Paths = {
  get document() {
    return new FakeDirectory('file:///doc');
  },
  get cache() {
    return new FakeDirectory('file:///cache');
  },
};

export const fakeFsModule = { File: FakeFile, Directory: FakeDirectory, Paths };

/** Testin denetimi. */
export const fakeFs = {
  reset() {
    files.clear();
    dirs.clear();
    state.failCopy = false;
    for (const d of ['file:///doc/', 'file:///cache/', 'file:///cache/ImageManipulator/']) dirs.add(d);
  },
  /** Dosya yazar (klasörleri de açar). */
  put(uri: string, content = uri) {
    new FakeDirectory(parentOf(uri)).create({ intermediates: true, idempotent: true });
    files.set(uri, content);
    return uri;
  },
  has: (uri: string) => files.has(uri),
  read: (uri: string) => files.get(uri),
  hasDir: (uri: string) => dirs.has(uri.endsWith('/') ? uri : `${uri}/`),
  /** Android / temizleyici uygulamanın önbelleğini sildi. */
  clearCache() {
    for (const f of [...files.keys()]) if (f.startsWith('file:///cache/')) files.delete(f);
  },
  /** Kopyalama hata versin (disk dolu). */
  set failCopy(v: boolean) {
    state.failCopy = v;
  },
  filesUnder: (prefix: string) => [...files.keys()].filter((f) => f.startsWith(prefix)).sort(),
};
