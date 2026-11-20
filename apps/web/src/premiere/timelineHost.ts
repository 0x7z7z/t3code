import { isPremierePanel } from "./host";
import type { TimelineSnapshot } from "./turnChanges";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (value: unknown, max = 2048): value is string =>
  typeof value === "string" && value.length <= max;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const point = (value: unknown) => value === null || finite(value);
const count = (value: unknown) => finite(value) && Number.isInteger(value) && value >= 0;
let nextRequest = 0;

export class TimelineRequestError extends Error {
  constructor(
    message: string,
    readonly unchanged: boolean,
  ) {
    super(message);
  }
}

export function parseTimelineSnapshot(value: unknown): TimelineSnapshot | null {
  if (
    !object(value) ||
    !text(value.projectId) ||
    !value.projectId ||
    !text(value.sequenceId, 512) ||
    !value.sequenceId ||
    !text(value.name) ||
    !count(value.videoTrackCount) ||
    !count(value.audioTrackCount) ||
    !point(value.inPoint) ||
    !point(value.outPoint) ||
    typeof value.truncated !== "boolean"
  )
    return null;
  let clips = 0;
  for (const key of ["videoTracks", "audioTracks"] as const) {
    const tracks = value[key];
    if (
      !Array.isArray(tracks) ||
      tracks.length > 256 ||
      tracks.length !==
        Math.min(
          value[key === "videoTracks" ? "videoTrackCount" : "audioTrackCount"] as number,
          256,
        )
    )
      return null;
    const indices = new Set<number>();
    for (const track of tracks) {
      if (
        !object(track) ||
        !count(track.index) ||
        (track.name !== undefined && !text(track.name)) ||
        (track.locked !== undefined && typeof track.locked !== "boolean") ||
        !finite(track.index) ||
        indices.has(track.index) ||
        track.index >= tracks.length ||
        !Array.isArray(track.clips)
      )
        return null;
      indices.add(track.index);
      clips += track.clips.length;
      if (clips > 2000) return null;
      for (const clip of track.clips) {
        if (
          !object(clip) ||
          !text(clip.name) ||
          !text(clip.nodeId) ||
          !text(clip.projectItemName) ||
          (clip.projectItemId !== undefined && !text(clip.projectItemId)) ||
          (clip.mediaPath !== undefined && !text(clip.mediaPath)) ||
          (clip.speed !== undefined && clip.speed !== null && !finite(clip.speed)) ||
          (clip.reversed !== undefined &&
            clip.reversed !== null &&
            typeof clip.reversed !== "boolean") ||
          !finite(clip.start) ||
          !finite(clip.end) ||
          !finite(clip.inPoint) ||
          !finite(clip.outPoint) ||
          clip.end < clip.start ||
          clip.outPoint < clip.inPoint ||
          (clip.enabled !== null && typeof clip.enabled !== "boolean")
        )
          return null;
      }
    }
  }
  if (!Array.isArray(value.markers) || value.markers.length > 500) return null;
  for (const marker of value.markers) {
    if (
      !object(marker) ||
      !text(marker.id) ||
      !text(marker.name) ||
      !text(marker.comments) ||
      !finite(marker.start) ||
      !finite(marker.end) ||
      marker.end < marker.start ||
      (marker.color !== null && (!count(marker.color) || (marker.color as number) > 7))
    )
      return null;
  }
  return value as unknown as TimelineSnapshot;
}

export interface SnapshotReply {
  snapshot: TimelineSnapshot;
  signature: string;
  checkpointId: string | null;
  checkpointSignature: string | null;
  checkpointError: string | null;
  checkpointIds: string[];
}

const LATE_REPLY_MS = 10 * 60 * 1000;

async function request(
  type: "snapshot" | "restore" | "prune" | "cut",
  fields: Record<string, unknown>,
  timeoutMs?: number,
  onLate?: (packet: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  if (!isPremierePanel()) throw new Error("Premiere is not connected.");
  return new Promise((resolve, reject) => {
    const requestId = `timeline-${Date.now()}-${++nextRequest}`;
    let settled = false;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = () => {
      clearTimeout(lateTimer);
      window.removeEventListener("message", onMessage);
    };
    const finish = (error: string | null, packet?: Record<string, unknown>, timedOut = false) => {
      settled = true;
      clearTimeout(timer);
      // After a timeout, a caller that can use a late reply keeps listening for
      // a while, so a slow Premiere edit still hands back its Undo checkpoint.
      if (timedOut && onLate) lateTimer = setTimeout(stopListening, LATE_REPLY_MS);
      else stopListening();
      if (error) reject(new TimelineRequestError(error, packet?.unchanged === true));
      else resolve(packet!);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window.parent ||
        (event.origin !== "null" && event.origin !== "file://") ||
        !object(event.data)
      )
        return;
      const packet = event.data;
      if (
        packet.protocol !== 1 ||
        packet.type !== `premiere.${type}` ||
        packet.requestId !== requestId
      )
        return;
      if (settled) {
        stopListening();
        if (packet.ok === true) onLate?.(packet);
        return;
      }
      if (packet.ok !== true)
        finish(
          text(packet.error) ? packet.error : "Premiere could not complete the timeline request.",
          packet,
        );
      else finish(null, packet);
    };
    const timer = setTimeout(
      () =>
        finish(
          "Premiere did not respond to the timeline request. Reopen the panel to retry.",
          undefined,
          true,
        ),
      // A cut first duplicates the sequence, which takes longer on big projects.
      timeoutMs ?? (type === "cut" ? 120000 : 15000),
    );
    window.addEventListener("message", onMessage);
    try {
      window.parent.postMessage(
        { type: `premiere.${type}.request`, protocol: 1, requestId, ...fields },
        "*",
      );
    } catch (error) {
      finish(error instanceof Error ? error.message : "Premiere message dispatch failed.");
    }
  });
}

export async function requestTimelineSnapshot(
  checkpoint: boolean,
  sequenceId?: string,
  timeoutMs?: number,
): Promise<SnapshotReply> {
  const packet = await request(
    "snapshot",
    { checkpoint, ...(sequenceId ? { sequenceId } : {}) },
    timeoutMs,
  );
  const snapshot = parseTimelineSnapshot(packet.snapshot);
  if (
    !snapshot ||
    !text(packet.signature, 4000000) ||
    (packet.checkpointId !== null && !text(packet.checkpointId, 512)) ||
    (packet.checkpointSignature !== null && !text(packet.checkpointSignature, 4000000)) ||
    (packet.checkpointError !== null && !text(packet.checkpointError)) ||
    !Array.isArray(packet.checkpointIds) ||
    packet.checkpointIds.length > 500 ||
    !packet.checkpointIds.every((id) => text(id, 512))
  )
    throw new Error("Premiere returned an invalid timeline snapshot.");
  return {
    snapshot,
    signature: packet.signature,
    checkpointId: packet.checkpointId,
    checkpointSignature: packet.checkpointSignature,
    checkpointError: packet.checkpointError,
    checkpointIds: packet.checkpointIds,
  } as SnapshotReply;
}

/**
 * Deletes the sequence's transcript-cut checkpoints other than `keepId`, which
 * undo may still need. Premiere refuses when a different project is open.
 */
export async function pruneCheckpoints(
  sequenceId: string,
  keepId: string | null,
  projectId: string,
): Promise<void> {
  await request("prune", { sequenceId, projectId, ...(keepId ? { keepId } : {}) });
}

export async function restoreTimeline(fields: {
  sequenceId: string;
  checkpointId: string;
  expectedSignature: string;
  checkpointSignature: string;
  turnNumber: number;
}): Promise<string | null> {
  const packet = await request("restore", fields);
  return text(packet.sequenceId, 512) ? packet.sequenceId : null;
}

type CutFields = {
  sequenceId: string;
  projectId: string;
};

export function cutTranscriptRanges(
  fields: CutFields & {
    ranges: readonly { start: number; end: number }[];
    expectedSignature: string;
  },
  onLate?: LateCut,
) {
  return requestCut(fields, onLate);
}

export function cutTranscriptRange(
  fields: CutFields & {
    start: number;
    end: number;
  },
  onLate?: LateCut,
) {
  return requestCut(fields, onLate);
}

export type CutResult = ReturnType<typeof parseCut>;

/** Called when Premiere finishes a cut after the panel stopped waiting for it. */
export type LateCut = (result: CutResult) => void;

async function requestCut(fields: object, onLate?: LateCut) {
  const packet = await request(
    "cut",
    { ...fields },
    undefined,
    onLate
      ? (late) => {
          try {
            onLate(parseCut(late));
          } catch {
            // An invalid late reply keeps the transcript marked uncertain.
          }
        }
      : undefined,
  );
  return parseCut(packet);
}

function parseCut(packet: Record<string, unknown>) {
  if (
    !parseTimelineSnapshot(packet.snapshot) ||
    !text(packet.signature, 4000000) ||
    !text(packet.checkpointId, 512) ||
    !packet.checkpointId ||
    !text(packet.checkpointSignature, 4000000) ||
    !packet.checkpointSignature ||
    (packet.cutError !== null && !text(packet.cutError))
  )
    throw new Error(
      "Invalid cut response. Inspect the timeline and its Axis checkpoint before retrying.",
    );
  return {
    snapshot: parseTimelineSnapshot(packet.snapshot)!,
    checkpointId: packet.checkpointId as string,
    checkpointSignature: packet.checkpointSignature as string,
    expectedSignature: packet.signature as string,
    cutError: packet.cutError as string | null,
  };
}
