import { useEffect, useState } from "react";
import { isPremierePanel, seekPremiere, type PremiereContext } from "./host";
import { parseClipIndex, type TimelineClip } from "./clipLinks";
import type { MarkerSuggestion } from "./suggestionBlocks";
import type { CleanupSettings } from "./transcriptCleanup";
import type { MusicPlan } from "./music";

let nextRequestId = 0;

function hostPacket(event: MessageEvent<unknown>) {
  if (event.source !== window.parent || (event.origin !== "null" && event.origin !== "file://"))
    return null;
  const packet = event.data;
  if (
    typeof packet !== "object" ||
    packet === null ||
    !("protocol" in packet) ||
    packet.protocol !== 1
  )
    return null;
  return packet;
}

export function requestTimelineAction(
  type:
    | "premiere.clips.request"
    | "premiere.select"
    | "premiere.markers.add"
    | "premiere.captions.request"
    | "premiere.music.request"
    | "premiere.transcript.load.request"
    | "premiere.diagnostics.request",
  payload: object,
): Promise<object> {
  if (!isPremierePanel())
    return Promise.reject(new Error("Open Axis inside Premiere to use timeline actions."));
  return new Promise((resolve, reject) => {
    const requestId = `axis-action-${++nextRequestId}`;
    const responseType = type.replace(/\.request$/, "");
    const finish = (error: string | null, packet: object) => {
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      if (error) reject(new Error(error));
      else resolve(packet);
    };
    const receive = (event: MessageEvent<unknown>) => {
      const packet = hostPacket(event);
      if (
        !packet ||
        !("requestId" in packet) ||
        packet.requestId !== requestId ||
        !("type" in packet) ||
        packet.type !== responseType
      )
        return;
      if (!("ok" in packet) || typeof packet.ok !== "boolean") return;
      finish(
        packet.ok
          ? null
          : "error" in packet && typeof packet.error === "string" && packet.error.length <= 1024
            ? packet.error
            : "Premiere could not complete this action.",
        packet,
      );
    };
    const timeout = setTimeout(
      () => finish("Premiere did not respond. Check the timeline before trying again.", {}),
      // Native caption import and Save dialogs can remain open for a while.
      type === "premiere.music.request"
        ? 660000
        : type === "premiere.captions.request"
          ? 120000
          : type === "premiere.diagnostics.request"
            ? 35000
            : 10000,
    );
    window.addEventListener("message", receive);
    try {
      window.parent.postMessage({ ...payload, type, protocol: 1, requestId }, "*");
    } catch (error) {
      finish(error instanceof Error ? error.message : "Premiere message dispatch failed.", {});
    }
  });
}

export interface TimelineActions {
  readonly reviewMusic?: (plan: MusicPlan) => void;
  readonly reviewCleanup?: (settings: CleanupSettings) => void;
  readonly sequenceId: string;
  readonly fps: number;
  readonly canAddMarkers: boolean;
  readonly clips: readonly TimelineClip[];
  readonly select: (clip: TimelineClip) => Promise<void>;
  readonly addMarkers: (markers: readonly MarkerSuggestion[]) => Promise<void>;
  readonly seek: (seconds: number) => void;
}

export function useTimelineClips(context: PremiereContext | null): readonly TimelineClip[] {
  const [index, setIndex] = useState<{ scope: string; clips: readonly TimelineClip[] } | null>(
    null,
  );
  const sequenceId = context?.sequenceId ?? "";
  const projectId = context?.projectDocumentId || context?.projectPath || "";
  const scope = JSON.stringify([context?.projectPath, context?.projectDocumentId, sequenceId]);
  useEffect(() => {
    if (!sequenceId || !isPremierePanel()) return;
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const packet = await requestTimelineAction("premiere.clips.request", {
          sequenceId,
          projectId,
        });
        if (
          disposed ||
          !("sequenceId" in packet) ||
          packet.sequenceId !== sequenceId ||
          !("clips" in packet)
        )
          return;
        const clips = parseClipIndex(packet.clips);
        if (clips) setIndex({ scope, clips });
      } catch {
        if (!disposed) setIndex(null);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sequenceId, projectId, scope]);
  return index?.scope === scope ? index.clips : [];
}

export function createTimelineActions(
  context: PremiereContext | null,
  clips: readonly TimelineClip[],
  canOperate: boolean,
): TimelineActions | undefined {
  if (!context) return undefined;
  const sequenceId = context.sequenceId;
  const projectId = context.projectDocumentId || context.projectPath;
  return {
    sequenceId,
    fps: context.fps,
    canAddMarkers: canOperate,
    clips,
    select: async (clip) => {
      await requestTimelineAction("premiere.select", {
        sequenceId,
        projectId,
        nodeId: clip.nodeId,
        trackType: clip.trackType,
        trackIndex: clip.trackIndex,
        start: clip.start,
      });
    },
    addMarkers: async (markers) => {
      if (!canOperate) throw new Error("This connection does not have editing permission.");
      await requestTimelineAction("premiere.markers.add", { sequenceId, projectId, markers });
    },
    seek: (seconds) => {
      seekPremiere(seconds, sequenceId);
    },
  };
}
