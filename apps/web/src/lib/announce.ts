// Screen readers skip a live region that appears already filled, and moving focus cuts off
// whatever they were saying. So the regions exist before the first message lands, and
// messages wait until focus has stayed put for a moment, then are spoken together.
const FOCUS_SETTLE_MS = 250;

let regions: readonly [HTMLElement, HTMLElement] | null = null;
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FOCUS_SETTLE_MS);
}

function flush() {
  if (!regions || pending.length === 0) return;
  const [first, second] = regions;
  // Alternating between two regions lets the same message be spoken twice in a row.
  const target = first.textContent ? second : first;
  first.textContent = "";
  second.textContent = "";
  target.textContent = pending.join(". ");
  pending = [];
}

function createRegion() {
  const region = document.createElement("div");
  region.className = "sr-only";
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  document.body.append(region);
  return region;
}

/** Tells screen reader users what an action did when focus alone doesn't show it. */
export function announce(message: string) {
  if (!regions) {
    regions = [createRegion(), createRegion()];
    document.addEventListener("focusin", () => {
      if (pending.length > 0) scheduleFlush();
    });
  }
  if (pending.at(-1) !== message) pending.push(message);
  scheduleFlush();
}
