import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// Capture before config and bootstrap reads to detect launcher loss during startup.
const startupParentPid = process.ppid;

/** Detects any parent change, including reparenting to subreapers, to release the backend lock.
 * Windows retains exited parent ids; init-started backends have no launcher. */
export const awaitLauncherLoss = (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly interval?: Duration.Input;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const launcherPid = options?.launcherPid ?? startupParentPid;
    const getParentPid = options?.getParentPid ?? (() => process.ppid);
    const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
    if (platform === "win32" || launcherPid <= 1) return yield* Effect.never;
    const poll: Effect.Effect<void> = Effect.suspend(() => {
      const parentPid = getParentPid();
      return parentPid === launcherPid
        ? Effect.flatMap(Effect.sleep(interval), () => poll)
        : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
            launcherPid,
            parentPid,
          });
    });
    return yield* poll;
  });
