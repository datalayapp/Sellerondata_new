// Değişmeyen derleme ağacı: başka ajanlar çalışma kopyasında yazarken yığın, kaydedilmiş sürümden derlenir.
//   node snapshot.mjs <hedef>           <hedef>/Platform + <hedef>/Deciship (HEAD), LF, git deposu değil
//   node snapshot.mjs <hedef> --clone   kullanıcının GitHub Desktop klonu gibi: core.autocrlf=true, dosyalar CRLF, .git var
// `SOD_E2E_ROOT=<hedef>/Platform` ile stack.mjs ve testler oradan çalışır.
// Platform ve Deciship tek depodadır; depo kökü Platform'un bir üstüdür.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
if (!process.argv[2]) throw new Error('hedef klasör gerekli');
const target = path.resolve(process.argv[2]);
const asClone = process.argv.includes('--clone');
const ref = 'HEAD';
// Platform ve araç klasörleri. Yeni araç klasörü eklenince `npm run products:check` burada eksik olduğunu söyler
// (Platform/scripts/products-lists.mjs kural 9: Platform'u tırnakla yazan satır her araç klasörünü de içermeli).
const FOLDERS = ['Platform', 'Deciship'];

if (asClone) {
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=true', repo, target]);
} else {
  fs.mkdirSync(target, { recursive: true });
  for (const name of FOLDERS) fs.rmSync(path.join(target, name), { recursive: true, force: true });
  const tar = path.join(target, 'snapshot.tar');
  execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', tar, ref, ...FOLDERS]);
  execFileSync('tar', ['-xf', 'snapshot.tar'], { cwd: target });
  fs.rmSync(tar);
}
const sha = execFileSync('git', ['-C', repo, 'rev-parse', '--short', ref], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
console.log(`${FOLDERS.join(' + ')} ${branch} ${sha}${asClone ? ' (klon, CRLF)' : ''}`);
