# Plan: Port Go's `context` package to a single-file TS vendor module

## Goal
Provide a faithful port of Go's standard `context` package as a single TypeScript
file that runs on Node.js >= 24 (native type-stripping, no build step) and is consumed
as vendored source rather than an npm package. It gives callers cancellation,
deadlines/timeouts, request-scoped values, and cancellation-cause propagation with an
API that mirrors Go while staying idiomatic to Node.

## Scope
Included:
- `Context` interface: `deadline()`, `done()`, `err()`, `value()`, plus a `signal`
  (`AbortSignal`) for native Node interop.
- Constructors/combinators: `background`, `todo`, `withCancel`, `withCancelCause`,
  `withDeadline`, `withDeadlineCause`, `withTimeout`, `withTimeoutCause`, `withValue`,
  `withoutCancel`, `afterFunc`, `cause`.
- Sentinel errors `Canceled` / `DeadlineExceeded` (with `instanceof`-able classes).
- Cancellation propagation parent → child via `AbortSignal`.

Out of scope:
- npm packaging / publishing (vendored source only).
- A bundler/build step (relies on Node 24 running `.ts` directly).
- Go's `time.Time`; deadlines are epoch-millisecond `number`s.

## Design decisions
- `Done() <-chan struct{}` → `done(): Promise<void>` that resolves on cancel, plus a
  `signal: AbortSignal` for `addEventListener` / `AbortSignal.any` interop.
- Internals built on `AbortController`; cancel cause is carried as `signal.reason`.
- `err()` returns `Canceled` / `DeadlineExceeded`; `cause()` returns the user-supplied
  cause (mirrors Go's split between `Err()` and `Cause()`).
- Propagation uses a one-shot `abort` listener registered with
  `{ signal: childController.signal }` so it auto-detaches when the child cancels,
  avoiding listener leaks on long-lived parents.
- camelCase function names (idiomatic JS) instead of Go's PascalCase.
- Avoid TS features that type-stripping rejects (no parameter properties, enums,
  namespaces) so the file runs directly under Node 24.

## Steps
1. Write this plan. *(done)*
2. Define `Context`/`Deadline` types, `CancelFunc`/`CancelCauseFunc`, and the
   `Canceled` / `DeadlineExceeded` sentinel errors.
3. Implement `EmptyCtx` (background/todo) backed by a never-aborting signal.
4. Implement `CancelCtx` with `AbortController`, parent-propagation, and `done()`
   promise caching.
5. Implement `ValueCtx`, `WithoutCancelCtx`, deadline/timer wiring, `afterFunc`,
   and `cause`.
6. Export named functions + a default namespace object.
7. Write a sanity test script and run it under Node 24.

## Risks & Open Questions
- Deadline timers are kept ref'd so the timeout reliably fires (Go-faithful); callers
  must invoke `cancel()` to release the timer, exactly like Go's `defer cancel()`.
- Abandoned (never-cancelled) child contexts stay referenced by a long-lived parent's
  listener — same leak class as Go; mitigated by always calling `cancel`.

## Estimated Complexity
Medium — single file, but careful parent/child cancellation and cause propagation.

## Outcome
Implemented `vendor/context.ts` (single file, no deps) covering the full planned
surface: `background`/`todo`, `withCancel`/`withCancelCause`,
`withDeadline`/`withDeadlineCause`, `withTimeout`/`withTimeoutCause`, `withValue`,
`withoutCancel`, `afterFunc`, `cause`, and `Canceled`/`DeadlineExceeded` sentinels.
Each `Context` exposes `deadline()`, `done()`, `err()`, `value()`, plus a native
`signal: AbortSignal`. Cancellation propagation, cause carrying, and timer cleanup
are built on `AbortController`.

`vendor/context.test.ts` exercises the API (9 checks) and passes via
`node vendor/context.test.ts` on Node v24.15.0 — no build step.

Deviations from the plan: none functional. Note: the test file shows an editor-only
TS diagnostic (`node:assert/strict` types missing) because this vendor repo has no
`package.json`/`@types/node`; it does not affect execution.

