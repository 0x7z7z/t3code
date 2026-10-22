import { memo, useEffect, useRef } from "react";

import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

/**
 * One polite live region for the open thread. Text is written straight to the
 * DOM so an announcement never re-renders the timeline.
 */
export const ThreadActivityAnnouncer = memo(function ThreadActivityAnnouncer({
  threadKey,
  status,
  requestId,
  runId,
  runStatus,
}: ThreadActivitySnapshot & {
  /** Null while the timeline shows another thread during a switch. */
  readonly threadKey: string | null;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<{ threadKey: string; memory: ThreadAnnouncementMemory } | null>(null);

  useEffect(() => {
    const region = regionRef.current;
    if (threadKey === null) {
      memoryRef.current = null;
      if (region !== null) region.textContent = "";
      return;
    }
    const previous = memoryRef.current?.threadKey === threadKey ? memoryRef.current.memory : null;
    const { memory, announcement } = nextThreadAnnouncement(previous, {
      status,
      requestId,
      runId,
      runStatus,
    });
    memoryRef.current = { threadKey, memory };
    if (region === null) return;
    if (previous === null) {
      region.textContent = "";
    } else if (announcement !== null) {
      // Screen readers ignore a write that leaves the text unchanged, so a
      // repeated "Done" gets a trailing non-breaking space to count as new.
      region.textContent = region.textContent === announcement ? `${announcement} ` : announcement;
    }
  }, [threadKey, status, requestId, runId, runStatus]);

  return <div ref={regionRef} role="status" aria-live="polite" className="sr-only" />;
});
