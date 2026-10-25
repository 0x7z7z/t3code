import { cleanupLabels, type CleanupCut, type CleanupSettings } from "./transcriptCleanup";
import { transcriptTime } from "./sequenceTranscript";

export function CleanupReview({
  cuts,
  excluded,
  settings,
  busy,
  canApply,
  onSettings,
  onToggle,
  onSeek,
  onApply,
  onClose,
}: {
  cuts: readonly CleanupCut[];
  excluded: ReadonlySet<string>;
  settings: CleanupSettings;
  busy: boolean;
  canApply: boolean;
  onSettings: (settings: CleanupSettings) => void;
  onToggle: (id: string) => void;
  onSeek: (seconds: number) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const accepted = cuts.filter((cut) => !excluded.has(cut.id));
  const saved = accepted.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  return (
    <section data-cleanup-review="" aria-label="Review voice-over cleanup">
      <header>
        <strong>Clean up</strong>
        <output aria-label="Cleanup savings">
          {accepted.length} cut{accepted.length === 1 ? "" : "s"} · {saved.toFixed(2)} s saved
        </output>
        <button type="button" disabled={busy} onClick={onClose}>
          Close review
        </button>
      </header>
      <fieldset disabled={busy}>
        <label>
          Pause threshold (s)
          <input
            type="number"
            min="0.1"
            max="30"
            step="0.1"
            value={settings.pauseThreshold}
            onChange={(event) =>
              onSettings({
                ...settings,
                pauseThreshold: Math.max(0.1, Math.min(30, Number(event.target.value) || 0.6)),
              })
            }
          />
        </label>
        <label>
          Padding each side (s)
          <input
            type="number"
            min="0"
            max="2"
            step="0.01"
            value={settings.padding}
            onChange={(event) =>
              onSettings({
                ...settings,
                padding: Math.max(0, Math.min(2, Number(event.target.value))),
              })
            }
          />
        </label>
        <label>
          Restart window (s)
          <input
            type="number"
            min="0"
            max="30"
            step="0.5"
            value={settings.restartWindow}
            onChange={(event) =>
              onSettings({
                ...settings,
                restartWindow: Math.max(0, Math.min(30, Number(event.target.value))),
              })
            }
          />
        </label>
        <label data-cleanup-fillers="">
          Filler words (comma separated)
          <input
            value={settings.fillers.join(",")}
            maxLength={2000}
            onChange={(event) =>
              onSettings({ ...settings, fillers: event.target.value.split(",").slice(0, 100) })
            }
          />
        </label>
      </fieldset>
      <div data-cleanup-groups="">
        {Object.entries(cleanupLabels).map(([type, label]) => {
          const group = cuts.filter((cut) => cut.type === type);
          return (
            <details key={type}>
              <summary>
                {label}{" "}
                <span>
                  {group.filter((cut) => !excluded.has(cut.id)).length}/{group.length}
                </span>
              </summary>
              {group.map((cut) => (
                <div data-cleanup-row="" key={cut.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!excluded.has(cut.id)}
                      disabled={busy}
                      aria-label={`Include ${cut.label} at ${transcriptTime(cut.start)}`}
                      onChange={() => onToggle(cut.id)}
                    />
                    {cut.label} · {(cut.end - cut.start).toFixed(2)} s
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Preview cut at ${transcriptTime(cut.start)}`}
                    onClick={() => onSeek(cut.start)}
                  >
                    Preview
                  </button>
                </div>
              ))}
            </details>
          );
        })}
      </div>
      {!cuts.length ? <p>No cuts found. Adjust the thresholds or filler list.</p> : null}
      <p>
        Click a highlight to keep or cut it and seek nearby. Accepted cuts ripple across unlocked
        V+A tracks. Locked tracks, captions and markers stay put. One checkpoint restores the entire
        cleanup.
      </p>
      {accepted.length > 2000 ? <p>Keep at most 2000 cuts per cleanup.</p> : null}
      <button
        type="button"
        data-danger=""
        disabled={busy || !canApply || !accepted.length || accepted.length > 2000}
        onClick={onApply}
      >
        {busy
          ? "Applying cleanup..."
          : `Apply ${accepted.length} cut${accepted.length === 1 ? "" : "s"}`}
      </button>
    </section>
  );
}
