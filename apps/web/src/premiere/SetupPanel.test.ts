import { expect, it } from "vite-plus/test";
import { parseDiagnostics } from "./setupDiagnostics";

it("rejects malformed reports so missing host information produces instructions instead of a crash", () => {
  for (const value of [null, {}, { python: null }, { python: { whisperx: true } }])
    expect(parseDiagnostics(value)).toBeNull();
});
