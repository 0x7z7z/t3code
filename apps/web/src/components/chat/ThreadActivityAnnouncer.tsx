import { memo, useEffect, useRef } from "react";

import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

// Long enough for a screen reader to finish a short label before the next one.
const ACTIVITY_ANNOUNCEMENT_INTERVAL_MS = 2_000;

/**
 * One polite live region for the open thread. Text is written straight to the
 * DOM so an announcement never re-renders the timeline.
 */
export const ThreadActivityAnnouncer = memo(function ThreadActivityAnnouncer({
  threadKey,
  status,
  activity,
  runId,
  runStatus,
}: ThreadActivitySnapshot & {
  /** Null while the timeline shows another thread during a switch. */
  readonly threadKey: string | null;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<{ threadKey: string; memory: ThreadAnnouncementMemory } | null>(null);
  const lastSpokenRef = useRef({ at: Number.NEGATIVE_INFINITY, text: "" });
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const cancelPending = () => {
      if (pendingRef.current !== null) clearTimeout(pendingRef.current);
      pendingRef.current = null;
    };
    const speak = (text: string) => {
      const region = regionRef.current;
      if (region === null) return;
      lastSpokenRef.current = { at: Date.now(), text };
      // Screen readers ignore a write that leaves the text unchanged, so a
      // repeated "Done" gets a trailing space to count as new.
      region.textContent = region.textContent === text ? `${text} ` : text;
    };

    if (threadKey === null) {
      memoryRef.current = null;
      cancelPending();
      return;
    }
    const previous = memoryRef.current?.threadKey === threadKey ? memoryRef.current.memory : null;
    const { memory, announcements } = nextThreadAnnouncement(previous, {
      status,
      activity,
      runId,
      runStatus,
    });
    memoryRef.current = { threadKey, memory };
    if (previous === null) {
      cancelPending();
      if (regionRef.current) regionRef.current.textContent = "";
      lastSpokenRef.current = { at: Number.NEGATIVE_INFINITY, text: "" };
      return;
    }
    if (announcements.length === 0) {
      // A queued label is stale once nothing is live, e.g. during compaction or
      // while a finished turn waits for its run to settle.
      if (status !== "working" || activity === null) cancelPending();
      return;
    }
    // A newer update replaces one still waiting, so only current activity is read.
    cancelPending();
    for (const announcement of announcements) {
      if (announcement.kind === "status") {
        speak(announcement.text);
        continue;
      }
      const wait = lastSpokenRef.current.at + ACTIVITY_ANNOUNCEMENT_INTERVAL_MS - Date.now();
      const speakActivity = () => {
        pendingRef.current = null;
        if (lastSpokenRef.current.text !== announcement.text) speak(announcement.text);
      };
      if (wait <= 0) speakActivity();
      else pendingRef.current = setTimeout(speakActivity, wait);
    }
  }, [threadKey, status, activity, runId, runStatus]);

  useEffect(
    () => () => {
      if (pendingRef.current !== null) clearTimeout(pendingRef.current);
    },
    [],
  );

  return <div ref={regionRef} role="status" aria-live="polite" className="sr-only" />;
});
