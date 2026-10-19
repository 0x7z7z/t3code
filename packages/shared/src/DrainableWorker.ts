import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;

  readonly drain: Effect.Effect<void>;
}

/** Scope closure drops queued items and resolves drain; failed items are logged and skipped without stopping the worker. */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const outstanding = yield* TxRef.make(0);
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), (queue) =>
      // Uncount only dropped items; a running item uncounts itself even after scope closure.
      TxQueue.clear(queue).pipe(
        Effect.flatMap((dropped) => TxRef.update(outstanding, (n) => n - dropped.length)),
        Effect.andThen(TxQueue.shutdown(queue)),
        Effect.tx,
      ),
    );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((a) =>
        // Capture construction-time throws as item defects instead of killing the loop.
        Effect.suspend(() => process(a)).pipe(
          // Item interruptions continue the loop; worker-fiber interruption still stops it.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("DrainableWorker item failed", cause),
          ),
          Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap((offered) => (offered ? TxRef.update(outstanding, (n) => n + 1) : Effect.void)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
