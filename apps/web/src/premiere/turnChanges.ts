import { parseTimelineSnapshot } from "./timelineHost";

export interface TimelineClip {
  name: string;
  nodeId: string;
  projectItemName: string;
  projectItemId?: string;
  mediaPath?: string;
  speed?: number | null;
  reversed?: boolean | null;
  start: number;
  end: number;
  inPoint: number;
  outPoint: number;
  enabled: boolean | null;
}
export interface TimelineMarker {
  id: string;
  name: string;
  start: number;
  end: number;
  comments: string;
  color: number | null;
}
export interface TimelineSnapshot {
  projectId: string;
  sequenceId: string;
  name: string;
  videoTrackCount: number;
  audioTrackCount: number;
  videoTracks: { index: number; name?: string; locked?: boolean; clips: TimelineClip[] }[];
  audioTracks: { index: number; name?: string; locked?: boolean; clips: TimelineClip[] }[];
  markers: TimelineMarker[];
  inPoint: number | null;
  outPoint: number | null;
  truncated: boolean;
}
export interface TimelineChange {
  id: string;
  kind:
    | "trim"
    | "move"
    | "remove"
    | "add"
    | "clipEdit"
    | "markerAdd"
    | "markerRemove"
    | "markerEdit"
    | "range"
    | "tracks";
  text: string;
  seconds: number;
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.00001;
const sameTime = (a: number | null, b: number | null) =>
  a === b || (a !== null && b !== null && close(a, b));

function clips(snapshot: TimelineSnapshot) {
  return (["videoTracks", "audioTracks"] as const).flatMap((kind) =>
    snapshot[kind].flatMap((track) =>
      track.clips.map((clip, position) => ({
        ...clip,
        track: `${kind === "videoTracks" ? "V" : "A"}${track.index + 1}`,
        key: `${kind}:${track.index}:${clip.nodeId || position}`,
      })),
    ),
  );
}

export function diffTimeline(before: TimelineSnapshot, after: TimelineSnapshot): TimelineChange[] {
  if (before.projectId !== after.projectId || before.sequenceId !== after.sequenceId) return [];
  const changes: TimelineChange[] = [];
  const add = (kind: TimelineChange["kind"], id: string, text: string, seconds: number) =>
    changes.push({
      kind,
      id: `${kind}:${id}:${changes.length}`,
      text,
      seconds: Math.max(0, seconds),
    });
  const oldClips = clips(before);
  const newClips = clips(after);
  const unmatched = new Set(newClips);
  const byNode = new Map<string, typeof newClips>();
  for (const clip of newClips) {
    if (clip.nodeId) byNode.set(clip.nodeId, [...(byNode.get(clip.nodeId) ?? []), clip]);
  }
  // Reserve IDs first so a fallback cannot steal an identifiable repeated source clip.
  const matches = new Map<(typeof oldClips)[number], (typeof newClips)[number]>();
  for (const clip of oldClips) {
    const next = clip.nodeId ? byNode.get(clip.nodeId)?.find((c) => unmatched.has(c)) : undefined;
    if (next) {
      matches.set(clip, next);
      unmatched.delete(next);
    }
  }
  for (const clip of oldClips) {
    if (matches.has(clip)) continue;
    const candidates = [...unmatched].filter(
      (c) =>
        (!clip.nodeId || !c.nodeId) &&
        c.projectItemName === clip.projectItemName &&
        (clip.projectItemName !== "" || c.name === clip.name),
    );
    const ranked = candidates
      .map((c) => ({
        clip: c,
        score:
          (c.track === clip.track ? 0 : 100000) +
          Math.abs(c.inPoint - clip.inPoint) * 100 +
          Math.abs(c.start - clip.start),
      }))
      .sort((a, b) => a.score - b.score);
    const next = ranked[0]?.clip;
    if (next) {
      matches.set(clip, next);
      unmatched.delete(next);
    }
  }
  for (const clip of oldClips) {
    const next = matches.get(clip);
    if (!next) {
      add("remove", clip.key, `${clip.name} removed from ${clip.track}`, clip.start);
      continue;
    }
    const trimmed =
      !close(clip.inPoint, next.inPoint) ||
      !close(clip.outPoint, next.outPoint) ||
      !close(clip.end - clip.start, next.end - next.start);
    if (trimmed) add("trim", clip.key, `${next.name} trimmed on ${next.track}`, next.start);
    // A head trim shifts start and source in together; it is not a second move.
    if (
      clip.track !== next.track ||
      (!close(next.start - clip.start, next.inPoint - clip.inPoint) &&
        !close(next.start, clip.start))
    )
      add("move", clip.key, `${next.name} moved to ${next.track}`, next.start);
    if (
      clip.enabled !== next.enabled ||
      clip.name !== next.name ||
      clip.projectItemName !== next.projectItemName ||
      clip.projectItemId !== next.projectItemId ||
      clip.speed !== next.speed ||
      clip.reversed !== next.reversed
    )
      add(
        "clipEdit",
        clip.key,
        `${next.name} ${next.enabled !== clip.enabled ? (next.enabled === false ? "disabled" : next.enabled === true ? "enabled" : "enable state changed") : "updated"} on ${next.track}`,
        next.start,
      );
  }
  for (const clip of unmatched)
    add("add", clip.key, `${clip.name} added to ${clip.track}`, clip.start);
  const markers = new Set(after.markers);
  for (const marker of before.markers) {
    const next =
      [...markers].find((m) => marker.id && m.id === marker.id) ??
      [...markers].find((m) => (!marker.id || !m.id) && close(m.start, marker.start)) ??
      [...markers].find((m) => (!marker.id || !m.id) && m.name === marker.name);
    const id = marker.id || `${marker.start}:${marker.name}`;
    if (!next) {
      add("markerRemove", id, `Marker ${marker.name || "Untitled"} removed`, marker.start);
      continue;
    }
    markers.delete(next);
    if (
      marker.name !== next.name ||
      marker.comments !== next.comments ||
      marker.color !== next.color ||
      !close(marker.start, next.start) ||
      !close(marker.end, next.end)
    )
      add("markerEdit", id, `Marker ${next.name || "Untitled"} updated`, next.start);
  }
  for (const marker of markers)
    add(
      "markerAdd",
      marker.id || `${marker.start}:${marker.name}`,
      `Marker ${marker.name || "Untitled"} added`,
      marker.start,
    );
  if (!sameTime(before.inPoint, after.inPoint) || !sameTime(before.outPoint, after.outPoint))
    add("range", "sequence", "Sequence in/out changed", after.inPoint ?? 0);
  if (
    before.videoTrackCount !== after.videoTrackCount ||
    before.audioTrackCount !== after.audioTrackCount
  )
    add(
      "tracks",
      "sequence",
      `Track count changed to ${after.videoTrackCount} video / ${after.audioTrackCount} audio`,
      0,
    );
  return changes;
}

const labels: Record<TimelineChange["kind"], [string, string]> = {
  trim: ["clip", "trimmed"],
  move: ["clip", "moved"],
  remove: ["clip", "removed"],
  add: ["clip", "added"],
  clipEdit: ["clip", "updated"],
  markerAdd: ["marker", "added"],
  markerRemove: ["marker", "removed"],
  markerEdit: ["marker", "updated"],
  range: ["sequence range", "changed"],
  tracks: ["track count", "changed"],
};
export function summarizeChanges(changes: readonly TimelineChange[]): string {
  const counts = new Map<TimelineChange["kind"], number>();
  for (const change of changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => {
      const [noun, verb] = labels[kind];
      return `${count} ${noun}${count === 1 ? "" : "s"} ${verb}`;
    })
    .join(" · ");
}

export interface TurnChangeRecord {
  threadId: string;
  turnId: string;
  messageId: string;
  turnNumber: number;
  createdAt: number;
  before: TimelineSnapshot;
  after?: TimelineSnapshot;
  signature?: string;
  checkpointId: string | null;
  checkpointSignature: string | null;
  checkpointError: string | null;
  changes: TimelineChange[];
  restored?: boolean;
  error?: string;
}

const STORAGE_KEY = "axis-turn-changes-v1";
export const MAX_TURN_RECORDS = 30;
export function readTurnChanges(storage: Pick<Storage, "getItem">): TurnChangeRecord[] {
  try {
    const values: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (typeof values !== "object" || values === null || Array.isArray(values)) return [];
    return Object.values(values)
      .slice(-MAX_TURN_RECORDS)
      .filter(
        (value): value is TurnChangeRecord =>
          typeof value === "object" &&
          value !== null &&
          typeof value.threadId === "string" &&
          typeof value.turnId === "string" &&
          typeof value.messageId === "string" &&
          typeof value.createdAt === "number" &&
          Number.isFinite(value.createdAt) &&
          Number.isInteger(value.turnNumber) &&
          value.turnNumber > 0 &&
          Array.isArray(value.changes) &&
          parseTimelineSnapshot(value.before) !== null &&
          (value.after === undefined || parseTimelineSnapshot(value.after) !== null) &&
          (value.signature === undefined || typeof value.signature === "string") &&
          (value.checkpointId === null || typeof value.checkpointId === "string") &&
          (value.checkpointSignature === null || typeof value.checkpointSignature === "string") &&
          (value.checkpointError === null || typeof value.checkpointError === "string") &&
          (value.error === undefined || typeof value.error === "string") &&
          (value.restored === undefined || typeof value.restored === "boolean") &&
          value.changes.every(
            (change: unknown) =>
              typeof change === "object" &&
              change !== null &&
              "id" in change &&
              typeof change.id === "string" &&
              "kind" in change &&
              typeof change.kind === "string" &&
              Object.hasOwn(labels, change.kind) &&
              "text" in change &&
              typeof change.text === "string" &&
              "seconds" in change &&
              typeof change.seconds === "number" &&
              Number.isFinite(change.seconds) &&
              change.seconds >= 0,
          ),
      );
  } catch {
    return [];
  }
}
export function writeTurnChanges(storage: Pick<Storage, "setItem">, records: TurnChangeRecord[]) {
  // A global byte cap also bounds sessions with unusually long clip/marker names.
  const bounded = records.slice(-MAX_TURN_RECORDS);
  const payload = () =>
    JSON.stringify(
      Object.fromEntries(bounded.map((record) => [`${record.threadId}:${record.turnId}`, record])),
    );
  while (bounded.length && payload().length > 4000000) bounded.shift();
  try {
    storage.setItem(STORAGE_KEY, payload());
  } catch {
    /* Keep the in-memory cards. */
  }
}
