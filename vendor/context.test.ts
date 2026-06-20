import assert from "node:assert/strict";
import {
  background,
  withCancel,
  withCancelCause,
  withTimeout,
  withValue,
  withoutCancel,
  afterFunc,
  cause,
  Canceled,
  DeadlineExceeded,
} from "./context.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let n = 0;
const ok = (name: string) => {
  n++;
  console.log(`ok ${n} - ${name}`);
};

// background is never canceled and carries no value.
{
  const ctx = background();
  assert.equal(ctx.err(), null);
  assert.equal(ctx.value("x"), undefined);
  assert.deepEqual(ctx.deadline(), { deadline: 0, ok: false });
  ok("background defaults");
}

// withCancel: done() resolves, err() and cause() report Canceled.
{
  const [ctx, cancel] = withCancel(background());
  let resolved = false;
  ctx.done().then(() => (resolved = true));
  assert.equal(ctx.err(), null);
  cancel();
  await Promise.resolve();
  assert.equal(resolved, true);
  assert.equal(ctx.err(), Canceled);
  assert.equal(cause(ctx), Canceled);
  assert.equal(ctx.signal.aborted, true);
  ok("withCancel cancels");
}

// withCancelCause: err is Canceled but cause is the custom error.
{
  const boom = new Error("boom");
  const [ctx, cancel] = withCancelCause(background());
  cancel(boom);
  assert.equal(ctx.err(), Canceled);
  assert.equal(cause(ctx), boom);
  ok("withCancelCause carries cause");
}

// Parent cancellation propagates to children (across a value layer).
{
  const [parent, cancel] = withCancel(background());
  const child = withValue(parent, "k", "v");
  const [gchild] = withCancel(child);
  cancel();
  await Promise.resolve();
  assert.equal(gchild.err(), Canceled);
  assert.equal(gchild.signal.aborted, true);
  ok("cancellation propagates to descendants");
}

// withTimeout fires DeadlineExceeded.
{
  const [ctx, cancel] = withTimeout(background(), 20);
  assert.equal(ctx.deadline().ok, true);
  await ctx.done();
  assert.equal(ctx.err(), DeadlineExceeded);
  assert.equal(cause(ctx), DeadlineExceeded);
  cancel();
  ok("withTimeout expires");
}

// Canceling before a timeout wins; err is Canceled, not DeadlineExceeded.
{
  const [ctx, cancel] = withTimeout(background(), 1000);
  cancel();
  await Promise.resolve();
  assert.equal(ctx.err(), Canceled);
  ok("cancel beats timeout");
}

// withValue lookups walk the chain.
{
  const ctx = withValue(withValue(background(), "a", 1), "b", 2);
  assert.equal(ctx.value("a"), 1);
  assert.equal(ctx.value("b"), 2);
  assert.equal(ctx.value("c"), undefined);
  assert.throws(() => withValue(background(), null, 1));
  ok("withValue chain + nil key guard");
}

// withoutCancel keeps values but detaches cancellation.
{
  const [parent, cancel] = withCancel(withValue(background(), "k", "v"));
  const detached = withoutCancel(parent);
  cancel();
  await Promise.resolve();
  assert.equal(parent.err(), Canceled);
  assert.equal(detached.err(), null);
  assert.equal(detached.value("k"), "v");
  ok("withoutCancel detaches but keeps values");
}

// afterFunc runs on cancel; stop prevents it.
{
  const [ctx, cancel] = withCancel(background());
  let ran = 0;
  afterFunc(ctx, () => ran++);
  cancel();
  await sleep(5);
  assert.equal(ran, 1);

  const [ctx2, cancel2] = withCancel(background());
  let ran2 = 0;
  const stop = afterFunc(ctx2, () => ran2++);
  assert.equal(stop(), true);
  cancel2();
  await sleep(5);
  assert.equal(ran2, 0);
  ok("afterFunc + stop");
}

console.log(`\n1..${n}\nall passed`);
