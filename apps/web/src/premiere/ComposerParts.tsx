import { useEffect, useRef, useState } from "react";
import type { RuntimeMode, UsageLimitsReport } from "@t3tools/contracts";
import { formatResetsIn, limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";
import { ChevronDownIcon, PaperclipIcon, XIcon } from "lucide-react";

import { runtimeModeConfig, runtimeModeOptions } from "../components/chat/runtimeModeConfig";
import type { ComposerImage, SlashItem } from "./composer";

/** T3's access modes, as a menu that opens above the composer. */
export function AccessModeMenu({
  value,
  disabled,
  onChange,
}: {
  value: RuntimeMode;
  disabled: boolean;
  onChange: (mode: RuntimeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const Current = runtimeModeConfig[value].icon;
  return (
    <div data-access-menu="" ref={root}>
      <button
        type="button"
        data-chip=""
        aria-label={`Access: ${runtimeModeConfig[value].label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Current size={13} aria-hidden="true" />
        {runtimeModeConfig[value].label}
        <ChevronDownIcon size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div role="menu" data-popover="">
          {runtimeModeOptions.map((mode) => {
            const Icon = runtimeModeConfig[mode].icon;
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={mode === value}
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                }}
              >
                <strong>
                  <Icon size={14} aria-hidden="true" />
                  {runtimeModeConfig[mode].label}
                </strong>
                <span>{runtimeModeConfig[mode].description}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SlashMenu({
  items,
  highlighted,
  onPick,
  onHover,
}: {
  items: ReadonlyArray<SlashItem>;
  highlighted: number;
  onPick: (item: SlashItem) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <div
      data-popover=""
      data-slash-menu=""
      role="listbox"
      aria-label="Commands and skills"
      ref={list}
    >
      {items.length === 0 ? (
        <p data-empty="">No matching commands or skills</p>
      ) : (
        items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            data-index={index}
            aria-selected={index === highlighted}
            // Keep focus in the textarea so typing continues after a pick.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(item)}
          >
            <strong>
              /{item.name}
              {item.kind === "skill" ? <em>skill</em> : null}
              {item.kind === "action" ? <em>panel</em> : null}
            </strong>
            {item.description ? <span>{item.description}</span> : null}
          </button>
        ))
      )}
    </div>
  );
}

export function ImageStrip({
  images,
  onRemove,
}: {
  images: ReadonlyArray<ComposerImage>;
  onRemove: (id: string) => void;
}) {
  if (!images.length) return null;
  return (
    <ul data-image-strip="" aria-label="Attached images">
      {images.map((image) => (
        <li key={image.id}>
          <img src={image.dataUrl} alt={image.name} />
          <button
            type="button"
            aria-label={`Remove ${image.name}`}
            onClick={() => onRemove(image.id)}
          >
            <XIcon size={11} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AttachButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        data-icon-button=""
        aria-label="Attach images"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon size={14} aria-hidden="true" />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );
}

/** The /usage-limits answer: remaining quota per window, read from T3's last limits check. */
export function UsageCard({ report, onClose }: { report: UsageLimitsReport; onClose: () => void }) {
  const now = Date.parse(report.createdAt);
  return (
    <section data-usage-card="" aria-label="Usage limits">
      <header>
        <strong>Usage limits</strong>
        <button type="button" data-icon-button="" aria-label="Close usage limits" onClick={onClose}>
          <XIcon size={13} aria-hidden="true" />
        </button>
      </header>
      {report.accounts.map((account) => {
        const notice = limitsNotice(account.limits);
        return (
          <div key={account.id} data-usage-account="">
            <span>
              {account.displayName || account.label}
              {account.plan ? ` · ${account.plan}` : ""}
            </span>
            {notice ? (
              <p>{notice}</p>
            ) : (
              account.limits.windows.map((window) => {
                const remaining = remainingPercent(window);
                return (
                  <div key={window.id} data-usage-window="">
                    <div>
                      <span>{window.label}</span>
                      <span>
                        {remaining}% left
                        {formatResetsIn(window, now) ? ` · ${formatResetsIn(window, now)}` : ""}
                      </span>
                    </div>
                    <meter min={0} max={100} low={20} high={50} optimum={100} value={remaining} />
                  </div>
                );
              })
            )}
          </div>
        );
      })}
      {report.notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </section>
  );
}
