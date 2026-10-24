import { useState } from "react";
import type { TimelineActions } from "./interactiveHost";

export function ClipButton({ name, actions }: { name: string; actions: TimelineActions }) {
  const matches = actions.clips.filter((clip) => clip.name === name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const select = async () => {
    const clip = matches[0];
    if (!clip || pending) return;
    setPending(true);
    setError(null);
    try {
      await actions.select(clip);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not select clip.");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <button
        type="button"
        data-clip-link=""
        aria-label={`Select ${name} in the timeline`}
        disabled={pending || !matches.length}
        onClick={() => void select()}
      >
        {name}
        {matches.length > 1 ? <small> ×{matches.length}</small> : null}
      </button>
      {error ? (
        <span data-action-error="" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
