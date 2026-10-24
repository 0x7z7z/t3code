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

async function request(
  type: "snapshot" | "restore",
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isPremierePanel()) throw new Error("Premiere is not connected.");
  return new Promise((resolve, reject) => {
    const requestId = `timeline-${Date.now()}-${++nextRequest}`;
    const finish = (error: string | null, packet?: Record<string, unknown>) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (error) reject(new Error(error));
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
      if (packet.ok !== true)
        finish(
          text(packet.error) ? packet.error : "Premiere could not complete the timeline request.",
        );
      else finish(null, packet);
    };
    const timer = setTimeout(
      () => finish("Premiere did not respond to the timeline request. Reopen the panel to retry."),
      15000,
    );
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      { type: `premiere.${type}.request`, protocol: 1, requestId, ...fields },
      "*",
    );
  });
}

export async function requestTimelineSnapshot(
  checkpoint: boolean,
  sequenceId?: string,
): Promise<SnapshotReply> {
  const packet = await request("snapshot", { checkpoint, ...(sequenceId ? { sequenceId } : {}) });
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

export async function restoreTimeline(fields: {
  sequenceId: string;
  checkpointId: string;
  expectedSignature: string;
  checkpointSignature: string;
  turnNumber: number;
}): Promise<void> {
  await request("restore", fields);
}
