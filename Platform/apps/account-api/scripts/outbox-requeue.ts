import { disconnectPrisma } from '../src/db.ts';
import { requeueDeadDeliveries } from '../src/lib/dispatcher.ts';

/** Teslim edilemeyen (DEAD) olayları yeniden kuyruğa alır. İmajda: node dist/outbox-requeue.js */
const count = await requeueDeadDeliveries();
console.log(`${count} olay yeniden kuyruğa alındı.`);
await disconnectPrisma();
