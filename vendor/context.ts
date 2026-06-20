/**
 * context — a faithful port of Go's standard `context` package to TypeScript.
 *
 * Single-file vendor module. Targets Node.js >= 24 and is intended to be run
 * directly via Node's native TypeScript type-stripping (no build step). It
 * therefore avoids TS syntax that type-stripping rejects (parameter properties,
 * enums, namespaces).
 *
 * A Context carries a cancellation signal, an optional deadline, and a set of
 * request-scoped values across API boundaries. The Go channel `Done()` is
 * modelled as a `Promise<void>` that resolves on cancellation, and every Context
 * additionally exposes a native `AbortSignal` (`ctx.signal`) for interop with
 * `fetch`, `addEventListener`, `AbortSignal.any`, etc.
 *
 * Mapping from Go:
 *   Background()            -> background()
 *   TODO()                  -> todo()
 *   WithCancel(p)           -> withCancel(p)            => [ctx, cancel]
 *   WithCancelCause(p)      -> withCancelCause(p)        => [ctx, cancel(cause?)]
 *   WithDeadline(p, t)      -> withDeadline(p, epochMs)  => [ctx, cancel]
 *   WithDeadlineCause       -> withDeadlineCause         => [ctx, cancel]
 *   WithTimeout(p, d)       -> withTimeout(p, ms)        => [ctx, cancel]
 *   WithTimeoutCause        -> withTimeoutCause          => [ctx, cancel]
 *   WithValue(p, k, v)      -> withValue(p, k, v)        => ctx
 *   WithoutCancel(p)        -> withoutCancel(p)          => ctx
 *   AfterFunc(ctx, f)       -> afterFunc(ctx, f)         => stop(): boolean
 *   Cause(ctx)              -> cause(ctx)
 *   context.Canceled        -> Canceled
 *   context.DeadlineExceeded-> DeadlineExceeded
 *
 * Always call the returned cancel function when a Context (or its work) is done,
 * even if it has a deadline — this releases resources (timers / parent listeners)
 * held by the Context. Mirrors Go's `defer cancel()`.
 */

/** A deadline expressed as epoch milliseconds; `ok` is false when unset. */
export interface Deadline {
  /** Epoch milliseconds at which the context expires (meaningful only if `ok`). */
  deadline: number;
  /** Whether a deadline is set. */
  ok: boolean;
}

/** Port of Go's `context.Context`. */
export interface Context {
  /** Returns the time when work done on behalf of this context should be canceled. */
  deadline(): Deadline;
  /** Resolves when this context is canceled; never resolves for a non-cancelable context. */
  done(): Promise<void>;
  /** The cancellation reason error (`Canceled`/`DeadlineExceeded`), or null while live. */
  err(): Error | null;
  /** Returns the value associated with `key`, or undefined. */
  value(key: unknown): unknown;
  /** Native AbortSignal mirroring this context's cancellation. */
  readonly signal: AbortSignal;
}

/** Cancels a context. Idempotent. */
export type CancelFunc = () => void;
/** Cancels a context, recording `cause` (defaults to `Canceled`). Idempotent. */
export type CancelCauseFunc = (cause?: Error) => void;

/** Returned by `err()` when a context is canceled. Analogue of `context.Canceled`. */
export class CanceledError extends Error {
  constructor() {
    super("context canceled");
    this.name = "CanceledError";
  }
}

/** Returned by `err()` when a context's deadline passes. Analogue of `context.DeadlineExceeded`. */
export class DeadlineExceededError extends Error {
  constructor() {
    super("context deadline exceeded");
    this.name = "DeadlineExceededError";
  }
  /** Mirrors Go's net.Error contract. */
  get timeout(): boolean {
    return true;
  }
}

/** Sentinel error: context was canceled. */
export const Canceled: Error = new CanceledError();
/** Sentinel error: context deadline passed. */
export const DeadlineExceeded: Error = new DeadlineExceededError();

// A signal that never aborts — used by non-cancelable contexts so children built
// from them don't bother registering propagation listeners.
const neverSignal: AbortSignal = new AbortController().signal;
// A promise that never settles — the `done()` of a non-cancelable context.
const neverPromise: Promise<void> = new Promise<void>(() => {});

/**
 * background / todo: an empty, non-cancelable, value-less Context. It is never
 * canceled, has no deadline, and carries no values.
 */
class EmptyCtx implements Context {
  #name: string;
  constructor(name: string) {
    this.#name = name;
  }
  deadline(): Deadline {
    return { deadline: 0, ok: false };
  }
  done(): Promise<void> {
    return neverPromise;
  }
  err(): Error | null {
    return null;
  }
  value(_key: unknown): unknown {
    return undefined;
  }
  get signal(): AbortSignal {
    return neverSignal;
  }
  toString(): string {
    return this.#name;
  }
}

const backgroundCtx: Context = new EmptyCtx("context.Background");
const todoCtx: Context = new EmptyCtx("context.TODO");

/** Root context for the main function, initialization, and tests. */
export function background(): Context {
  return backgroundCtx;
}

/** Like `background`, but signals that the correct context is not yet known. */
export function todo(): Context {
  return todoCtx;
}

/**
 * A cancelable context. Built on an AbortController; the cancellation cause is
 * carried as `signal.reason`, while `err()` reports the coarse Canceled /
 * DeadlineExceeded distinction (mirroring Go's `Err()` vs `Cause()`).
 */
class CancelCtx implements Context {
  #parent: Context;
  #controller: AbortController;
  #err: Error | null = null;
  #done: Promise<void> | undefined = undefined;
  #deadline: Deadline | undefined = undefined;
  #timer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(parent: Context) {
    this.#parent = parent;
    this.#controller = new AbortController();

    const ps = parent.signal;
    if (ps.aborted) {
      // Parent already canceled — inherit its error and cause immediately.
      this.cancel(parent.err() ?? Canceled, cause(parent) ?? Canceled);
    } else if (ps !== neverSignal) {
      // Propagate parent cancellation. The listener auto-detaches when *this*
      // context is canceled (via the `signal` option), preventing leaks on a
      // long-lived parent.
      ps.addEventListener(
        "abort",
        () => {
          this.cancel(this.#parent.err() ?? Canceled, cause(this.#parent) ?? Canceled);
        },
        { once: true, signal: this.#controller.signal },
      );
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  deadline(): Deadline {
    return this.#deadline ?? this.#parent.deadline();
  }

  done(): Promise<void> {
    if (this.#done === undefined) {
      const s = this.#controller.signal;
      if (s.aborted) {
        this.#done = Promise.resolve();
      } else {
        this.#done = new Promise<void>((resolve) => {
          s.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    }
    return this.#done;
  }

  err(): Error | null {
    return this.#controller.signal.aborted ? this.#err : null;
  }

  value(key: unknown): unknown {
    return this.#parent.value(key);
  }

  // Internal — not part of the Context interface, so hidden from typed consumers.

  /** Cancels this context with the given error and cause. Idempotent. */
  cancel(err: Error, causeErr: Error): void {
    if (this.#controller.signal.aborted) return;
    this.#err = err;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // `reason` carries the cause; children read it via `cause()`.
    this.#controller.abort(causeErr);
  }

  setDeadline(d: Deadline): void {
    this.#deadline = d;
  }

  setTimer(t: ReturnType<typeof setTimeout>): void {
    this.#timer = t;
  }
}

/**
 * Returns a copy of `parent` plus a cancel function. Canceling the returned
 * context (or canceling/expiring `parent`) cancels its children.
 */
export function withCancel(parent: Context): [Context, CancelFunc] {
  const c = new CancelCtx(parent);
  return [c, () => c.cancel(Canceled, Canceled)];
}

/**
 * Like `withCancel` but the cancel function accepts a cause, retrievable via
 * `cause(ctx)`. `err()` still reports `Canceled`.
 */
export function withCancelCause(parent: Context): [Context, CancelCauseFunc] {
  const c = new CancelCtx(parent);
  return [c, (causeErr?: Error) => c.cancel(Canceled, causeErr ?? Canceled)];
}

/**
 * Returns a copy of `parent` with the deadline adjusted to be no later than
 * `deadlineEpochMs`. When the deadline passes, the context is canceled with
 * `DeadlineExceeded`.
 */
export function withDeadline(parent: Context, deadlineEpochMs: number): [Context, CancelFunc] {
  return withDeadlineCause(parent, deadlineEpochMs, undefined);
}

/** Like `withDeadline` but records `causeErr` as the cause on expiry. */
export function withDeadlineCause(
  parent: Context,
  deadlineEpochMs: number,
  causeErr?: Error,
): [Context, CancelFunc] {
  const pd = parent.deadline();
  if (pd.ok && pd.deadline <= deadlineEpochMs) {
    // Parent's deadline is already sooner; a plain cancel context suffices.
    return withCancel(parent);
  }

  const c = new CancelCtx(parent);
  c.setDeadline({ deadline: deadlineEpochMs, ok: true });

  // Parent might have canceled us during construction.
  if (c.err() === null) {
    const dur = deadlineEpochMs - Date.now();
    if (dur <= 0) {
      c.cancel(DeadlineExceeded, causeErr ?? DeadlineExceeded);
    } else {
      const timer = setTimeout(() => c.cancel(DeadlineExceeded, causeErr ?? DeadlineExceeded), dur);
      c.setTimer(timer);
    }
  }

  return [c, () => c.cancel(Canceled, Canceled)];
}

/** Returns `withDeadline(parent, now + ms)`. */
export function withTimeout(parent: Context, ms: number): [Context, CancelFunc] {
  return withDeadline(parent, Date.now() + ms);
}

/** Like `withTimeout` but records `causeErr` as the cause on expiry. */
export function withTimeoutCause(parent: Context, ms: number, causeErr?: Error): [Context, CancelFunc] {
  return withDeadlineCause(parent, Date.now() + ms, causeErr);
}

/**
 * A context carrying a single key/value pair. Lookups delegate to the parent
 * for any other key; cancellation/deadline are inherited from the parent.
 */
class ValueCtx implements Context {
  #parent: Context;
  #key: unknown;
  #val: unknown;
  constructor(parent: Context, key: unknown, val: unknown) {
    this.#parent = parent;
    this.#key = key;
    this.#val = val;
  }
  deadline(): Deadline {
    return this.#parent.deadline();
  }
  done(): Promise<void> {
    return this.#parent.done();
  }
  err(): Error | null {
    return this.#parent.err();
  }
  get signal(): AbortSignal {
    return this.#parent.signal;
  }
  value(key: unknown): unknown {
    if (key === this.#key) return this.#val;
    return this.#parent.value(key);
  }
}

/**
 * Returns a copy of `parent` in which `value(key)` returns `val`. Keys are
 * compared with `===`. `null`/`undefined` keys are rejected.
 */
export function withValue(parent: Context, key: unknown, val: unknown): Context {
  if (key === null || key === undefined) {
    throw new Error("context: nil key");
  }
  return new ValueCtx(parent, key, val);
}

/**
 * A context that keeps `parent`'s values but is detached from its cancellation
 * and deadline — it is never canceled.
 */
class WithoutCancelCtx implements Context {
  #parent: Context;
  constructor(parent: Context) {
    this.#parent = parent;
  }
  deadline(): Deadline {
    return { deadline: 0, ok: false };
  }
  done(): Promise<void> {
    return neverPromise;
  }
  err(): Error | null {
    return null;
  }
  get signal(): AbortSignal {
    return neverSignal;
  }
  value(key: unknown): unknown {
    return this.#parent.value(key);
  }
}

/**
 * Returns a copy of `parent` that is not canceled when `parent` is. The returned
 * context returns no deadline, never resolves `done()`, and `err()` is null, but
 * still returns `parent`'s values.
 */
export function withoutCancel(parent: Context): Context {
  return new WithoutCancelCtx(parent);
}

/**
 * Arranges to call `fn` (in a fresh microtask, like a goroutine) after `ctx` is
 * canceled. Returns a `stop` function: calling it returns true if it prevented
 * `fn` from running, false if `fn` has already been started or stop was already
 * called.
 */
export function afterFunc(ctx: Context, fn: () => void): () => boolean {
  const s = ctx.signal;
  let done = false;

  const run = (): void => {
    done = true;
    queueMicrotask(fn);
  };

  if (s.aborted) {
    run();
    return () => false;
  }

  const onAbort = (): void => {
    run();
  };
  s.addEventListener("abort", onAbort, { once: true });

  return function stop(): boolean {
    if (done) return false;
    done = true;
    s.removeEventListener("abort", onAbort);
    return true;
  };
}

/**
 * Returns the cause that canceled `ctx`: the value passed to a cancel-cause
 * function, the deadline error, or `Canceled`. Returns null if `ctx` is not yet
 * canceled (or is not cancelable).
 */
export function cause(ctx: Context): Error | null {
  const s = ctx.signal;
  if (!s.aborted) return null;
  const reason = s.reason;
  if (reason instanceof Error) return reason;
  return ctx.err() ?? Canceled;
}

export default {
  background,
  todo,
  withCancel,
  withCancelCause,
  withDeadline,
  withDeadlineCause,
  withTimeout,
  withTimeoutCause,
  withValue,
  withoutCancel,
  afterFunc,
  cause,
  Canceled,
  DeadlineExceeded,
  CanceledError,
  DeadlineExceededError,
};
