/// <reference lib="webworker" />
/**
 * Recovery serialisation worker — the stringify + gzip of an autosave snapshot,
 * off the main thread.
 *
 * All logic is `RecoverySerializer` (unit-tested, and the inline fallback in
 * `recovery.ts`); this file is only the execution seam. It holds the
 * serializer across messages, which is what lets an unchanged document be
 * answered with `unchanged` instead of a new body.
 */

import { RecoverySerializer, type RecoveryJob } from './recoverySerializer';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const serializer = new RecoverySerializer();

ctx.onmessage = (e: MessageEvent<RecoveryJob>): void => {
  ctx.postMessage(serializer.run(e.data));
};
