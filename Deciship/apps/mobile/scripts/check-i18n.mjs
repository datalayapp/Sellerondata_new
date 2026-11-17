#!/usr/bin/env node
// Ortak betiğe sarmalayıcı: asıl denetim Platform/scripts/check-i18n.mjs içindedir (Platform/docs, Mesaj 12 §3.5).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.resolve(here, '../../../..', 'Platform/scripts/check-i18n.mjs');
const r = spawnSync(process.execPath, [shared, '--root', path.resolve(here, '..'), '--locales', 'src/locales', '--src', 'src,app', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
