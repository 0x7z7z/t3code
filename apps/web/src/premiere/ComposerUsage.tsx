import { useId, useState } from "react";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "../lib/contextWindow";

// oxlint-disable-next-line t3code/no-em-dash-copy -- The requested unavailable-value glyph, not prose punctuation.
const unavailable = "\u2014";
const tokens = (value: number | null | undefined) =>
  value == null ? unavailable : value.toLocaleString("en-US");

export function ComposerUsage({
  context,
  limits,
  account,
}: {
  context: ContextWindowSnapshot | null;
  limits: ServerProviderUsageLimits | undefined;
  account: string | undefined;
}) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const percentage = context?.usedPercentage ?? null;
  const level =
    percentage === null
      ? "unknown"
      : percentage > 95
        ? "red"
        : percentage > 80
          ? "amber"
          : "normal";
  const used = percentage === null ? unavailable : `${Math.round(percentage)}%`;
  const windows = limits?.unavailable?.reason === "unsupported" ? [] : (limits?.windows ?? []);
  const session = windows.find(
    (window) =>
      window.windowDurationMins === 300 ||
      window.id === "five_hour" ||
      (window.kind === "session" && window.windowDurationMins === undefined),
  );
  const weekly = windows.filter(
    (window) => window.kind === "weekly" || window.windowDurationMins === 10_080,
  );
  const rows = [
    { label: "5-hour", window: session },
    ...(weekly.length
      ? weekly.map((window) => ({ label: window.label, window }))
      : [{ label: "Weekly", window: undefined }]),
  ];

  return (
    <div
      data-composer-usage=""
      data-usage-level={level}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        data-icon-button=""
        aria-label={`Context window ${used} used`}
        aria-describedby={tooltipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--border)" strokeWidth="2" />
          {percentage === null ? (
            <text x="10" y="13" textAnchor="middle">
              {unavailable}
            </text>
          ) : (
            <circle
              cx="10"
              cy="10"
              r="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={2 * Math.PI * 7.5}
              strokeDashoffset={
                2 * Math.PI * 7.5 * (1 - Math.min(100, Math.max(0, percentage)) / 100)
              }
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
      </button>
      <div data-popover="" data-usage-popover="" role="tooltip" id={tooltipId} hidden={!open}>
        <strong>Context window</strong>
        <output aria-label="Context window tokens">
          {tokens(context?.usedTokens)} / {tokens(context?.maxTokens)} tokens ({used})
        </output>
        <strong>Usage limits{account ? ` - ${account}` : ""}</strong>
        {rows.map(({ label, window }) => {
          const reset = window?.resetsAt ? new Date(window.resetsAt) : null;
          return (
            <div data-usage-window="" key={window?.id ?? label}>
              <span>{label}</span>
              <output aria-label={`${label} usage`}>
                {window ? `${Math.round(window.usedPercent)}% used` : unavailable}
              </output>
              <small>
                Resets{" "}
                {reset && Number.isFinite(reset.getTime()) ? (
                  <time dateTime={window?.resetsAt}>{reset.toLocaleString()}</time>
                ) : (
                  unavailable
                )}
              </small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
