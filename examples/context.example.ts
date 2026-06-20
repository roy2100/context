/**
 * Runnable examples for the vendored `context` module.
 *
 *   node examples/context.example.ts
 *
 * Each block mirrors a common Go context idiom.
 */

import {
  background,
  withCancel,
  withTimeout,
  withValue,
  withoutCancel,
  afterFunc,
  cause,
  type Context,
} from "../vendor/context.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (...args: unknown[]) => console.log(...args);

// ---------------------------------------------------------------------------
// 1. Cancellation — a worker that stops promptly when its context is canceled.
//    `Promise.race` against `ctx.done()` is the JS analogue of Go's
//    `select { case <-ctx.Done(): ... }`.
// ---------------------------------------------------------------------------
async function worker(ctx: Context, id: number): Promise<void> {
  for (let i = 0; ; i++) {
    if (ctx.err() !== null) {
      log(`worker ${id}: stopping — ${ctx.err()?.message} (cause: ${cause(ctx)?.message})`);
      return;
    }
    await Promise.race([sleep(50), ctx.done()]);
    if (ctx.err() === null) log(`worker ${id}: tick ${i}`);
  }
}

async function cancellationExample(): Promise<void> {
  log("\n=== 1. cancellation ===");
  const [ctx, cancel] = withCancel(background());
  const done = Promise.all([worker(ctx, 1), worker(ctx, 2)]);
  await sleep(120);
  log("main: cancel()");
  cancel();
  await done;
}

// ---------------------------------------------------------------------------
// 2. Timeout — pass `ctx.signal` straight to any AbortSignal-aware API
//    (here a fake fetch). The deadline aborts the operation for us.
// ---------------------------------------------------------------------------
function fakeFetch(signal: AbortSignal, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(`response after ${ms}ms`), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

async function timeoutExample(): Promise<void> {
  log("\n=== 2. timeout ===");
  const [ctx, cancel] = withTimeout(background(), 100);
  try {
    log("fetch(slow):", await fakeFetch(ctx.signal, 300)); // aborted by deadline
  } catch (err) {
    log("fetch(slow): failed —", (err as Error).message);
  } finally {
    cancel(); // always release the timer
  }

  const [ctx2, cancel2] = withTimeout(background(), 300);
  try {
    log("fetch(fast):", await fakeFetch(ctx2.signal, 50)); // completes in time
  } finally {
    cancel2();
  }
}

// ---------------------------------------------------------------------------
// 3. Request-scoped values — carry a trace id down a call chain without
//    threading it through every signature.
// ---------------------------------------------------------------------------
const traceKey = Symbol("traceId");

function handle(ctx: Context): void {
  log(`handle: traceId=${String(ctx.value(traceKey))}`);
}

function valueExample(): void {
  log("\n=== 3. values ===");
  const ctx = withValue(background(), traceKey, "abc-123");
  handle(ctx);
}

// ---------------------------------------------------------------------------
// 4. afterFunc + withoutCancel — run cleanup on cancel, then do detached work
//    (e.g. flush logs) that must outlive the canceled request.
// ---------------------------------------------------------------------------
async function afterFuncExample(): Promise<void> {
  log("\n=== 4. afterFunc + withoutCancel ===");
  const [ctx, cancel] = withCancel(withValue(background(), traceKey, "xyz-789"));

  afterFunc(ctx, () => log("afterFunc: request canceled, releasing resources"));

  cancel();
  // The request is canceled, but a detached context still has the values and
  // is never canceled — good for fire-and-forget cleanup.
  const bg = withoutCancel(ctx);
  await sleep(0);
  log(`detached flush: traceId=${String(bg.value(traceKey))}, err=${bg.err()}`);
}

await cancellationExample();
await timeoutExample();
valueExample();
await afterFuncExample();
log("\ndone.");
