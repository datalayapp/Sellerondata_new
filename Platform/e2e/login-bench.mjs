// auth/login ölçümü, yalnız sod-e2e yığınında. Hız sınırı kapatılmaz: kovalar ölçüm dışında boşaltılır.
//   node login-bench.mjs              200 ardışık + 20 paralel + kap içinde argon2
//   node login-bench.mjs --yuk        aynısı, 16 CPU döngüsü ve 1,5 GiB bellek baskısı altında (kısa ölçüm)
import { spawn, spawnSync } from 'node:child_process';

const BASE = 'http://localhost:18188';
const PG = 'sod-e2e-postgres-1';
const API = 'sod-e2e-account-api-1';
const LOAD = process.argv.includes('--yuk');
const PASSWORD = 'Olcum-Sifre-12345!';

const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
const clearLimits = () => docker('exec', PG, 'psql', '-U', 'postgres', '-d', 'sellerondata', '-qAtc', 'DELETE FROM platform."RateBucket"');
const stats = (a) => {
  const s = a.map((x) => x.ms).sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const by = {};
  for (const x of a) by[x.status] = (by[x.status] ?? 0) + 1;
  return { n: a.length, min: Math.round(s[0]), p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), enKotu: Math.round(s.at(-1)), durum: by };
};
async function login(identifier) {
  const t = performance.now();
  try {
    const r = await fetch(`${BASE}/api/account/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password: PASSWORD, client: 'mobile' }) });
    await r.text();
    return { ms: performance.now() - t, status: r.status };
  } catch (e) {
    return { ms: performance.now() - t, status: e.cause?.code ?? 'ag-hatasi' };
  }
}
async function host() {
  const r = spawnSync('powershell', ['-NoProfile', '-c', '$o=Get-CimInstance Win32_OperatingSystem; $c=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; "bos_bellek_mb=$([int]($o.FreePhysicalMemory/1024)) cpu_yuzde=$c"'], { encoding: 'utf8' });
  return r.stdout.trim();
}

// Ölçüm kişileri: aynı kişiyle 10 girişte kişi+IP sınırı devreye girer.
const people = [];
for (let i = 0; i < 20; i++) {
  clearLimits();
  const email = `olcum${Date.now()}${i}@e2e.sellerondata.test`;
  const r = await fetch(`${BASE}/api/account/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sod-csrf': '1', origin: BASE },
    body: JSON.stringify({ orgName: `Ölçüm ${i}`, name: 'Ölçüm Kişi', email, password: PASSWORD, country: 'TR', locale: 'tr' }),
  });
  if (!r.ok) throw new Error(`kayıt ${r.status} ${await r.text()}`);
  people.push(email);
}

const spinners = [];
if (LOAD) {
  // Kendi tek kullanımlık kaplarımız: 16 çekirdek döngü + bellek baskısı. Ölçüm bitince silinir.
  const n = docker('info', '--format', '{{.NCPU}}').stdout.trim() || '16';
  spinners.push(spawn('docker', ['run', '--rm', '--name', 'sod-e2e-yuk', 'alpine', 'sh', '-c', `for i in $(seq 1 ${n}); do (while :; do :; done) & done; head -c 1500m /dev/zero | tail > /dev/null & sleep 3600`], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 4000));
}

const N = LOAD ? 60 : 200;
console.log('makine', await host());
const seq = [];
for (let i = 0; i < N; i++) {
  if (i % 8 === 0) clearLimits();
  seq.push(await login(people[i % people.length]));
}
console.log(`ardisik${N}`, JSON.stringify(stats(seq)));
console.log('makine', await host());
clearLimits();
const par = await Promise.all(people.map((p) => login(p)));
console.log('paralel20', JSON.stringify(stats(par)));

// Argon2 tek başına, kabın içinde: ağ ve veritabanı yok. Aynı parametre (32 MiB, t=3, p=1).
const code = `import('argon2').then(async ({default:a})=>{const o={type:a.argon2id,memoryCost:32768,timeCost:3,parallelism:1};const h=await a.hash('x'.repeat(16),o);
const seq=[];for(let i=0;i<20;i++){const t=performance.now();await a.verify(h,'x'.repeat(16));seq.push(performance.now()-t)}
const t=performance.now();const par=await Promise.all(Array.from({length:20},async()=>{const b=performance.now();await a.verify(h,'x'.repeat(16));return performance.now()-b}));
const f=(x)=>{x=[...x].sort((p,q)=>p-q);return {p50:Math.round(x[Math.floor(x.length/2)]),enKotu:Math.round(x.at(-1))}};
console.log(JSON.stringify({tek:f(seq),paralel20:f(par),paralelToplamMs:Math.round(performance.now()-t),threadpool:process.env.UV_THREADPOOL_SIZE??'4 (varsayılan)',cpu:require?0:0}))})`.replace(',cpu:require?0:0', '');
const ar = docker('exec', API, 'node', '-e', code);
console.log('argon2', ar.stdout.trim() || ar.stderr.trim().slice(0, 300));

if (LOAD) {
  docker('rm', '-f', 'sod-e2e-yuk');
  spinners.forEach((s) => s.kill());
}
