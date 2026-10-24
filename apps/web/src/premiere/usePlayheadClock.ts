import { useEffect, useState } from "react";
import {
  getPremiereHostState,
  getPremierePlayheadSample,
  samePremiereScope,
  subscribePremiereHost,
} from "./host";
import { PlayheadClock } from "./transcriptSync";

// Rounded rAF timestamps should still allow every other frame at 60 Hz to render.
const renderIntervalMs = 1000 / 30 - 0.5;

export function usePlayheadClock(enabled: boolean): number {
  const [seconds, setSeconds] = useState(
    () =>
      getPremierePlayheadSample()?.seconds ?? getPremiereHostState().context?.playheadSeconds ?? 0,
  );

  useEffect(() => {
    if (!enabled) return;
    let clock = new PlayheadClock();
    let previousSample: ReturnType<typeof getPremierePlayheadSample> = null;
    let previousContext = getPremiereHostState().context;
    let animation: number | null = null;
    let lastRender = -Infinity;

    const stop = () => {
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null;
    };
    const animate = (atMs: number) => {
      animation = null;
      if (atMs - lastRender >= renderIntervalMs) {
        lastRender = atMs;
        setSeconds(clock.now(atMs));
      }
      if (clock.playing) animation = requestAnimationFrame(animate);
    };
    const receive = () => {
      const context = getPremiereHostState().context;
      const sample = getPremierePlayheadSample();
      if (!samePremiereScope(previousContext, context) || !sample) {
        clock = new PlayheadClock();
        previousSample = null;
        stop();
      }
      previousContext = context;
      if (!sample) {
        setSeconds(context?.playheadSeconds ?? 0);
        return;
      }
      if (sample === previousSample) return;
      previousSample = sample;
      clock.sample(sample.seconds, sample.receivedAt, sample.readId);
      const atMs = performance.now();
      if (!clock.playing || atMs - lastRender >= renderIntervalMs) {
        lastRender = atMs;
        setSeconds(clock.now(atMs));
      }
      if (clock.playing) {
        if (animation === null) animation = requestAnimationFrame(animate);
      } else stop();
    };

    const unsubscribe = subscribePremiereHost(receive);
    receive();
    return () => {
      unsubscribe();
      stop();
    };
  }, [enabled]);

  return seconds;
}
