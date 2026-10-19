import type { NativeLayoutMetrics } from "./reserved-regions";

/**
 * Hardware type does not imply column count: iPad Slide Over and narrow Duo windows may lack sidebar space.
 * Android has no metrics observer and reports phone.
 */
export type DeviceType = "phone" | "duo-folded" | "duo-unfolded" | "pad";

export function deriveDeviceType(input: {
  readonly isPad: boolean;
  readonly metrics: NativeLayoutMetrics | null;
}): DeviceType {
  if (input.isPad) return "pad";
  // The hinge arrives with the first native layout pass, so a Duo reads as a
  // phone until then. Compact width also covers a narrow inner-display window.
  if (input.metrics?.hasHinge !== true) return "phone";
  return input.metrics.horizontalSizeClass === "regular" ? "duo-unfolded" : "duo-folded";
}

export function isDuoDevice(deviceType: DeviceType): boolean {
  return deviceType === "duo-folded" || deviceType === "duo-unfolded";
}
