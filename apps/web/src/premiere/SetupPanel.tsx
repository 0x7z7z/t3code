import { useEffect, useState } from "react";
import type { ServerProvider } from "@t3tools/contracts";
import { isPremierePanel, requestPremiereContext } from "./host";
import { requestTimelineAction } from "./interactiveHost";

import { parseDiagnostics, type AxisDiagnostics } from "./setupDiagnostics";

async function readDiagnostics() {
  const packet = await requestTimelineAction("premiere.diagnostics.request", {});
  return parseDiagnostics("report" in packet ? packet.report : null);
}

export function SetupPanel({
  ready,
  connected,
  providers,
  diagnostics,
  onAccounts,
}: {
  ready: boolean;
  connected: boolean;
  providers: readonly ServerProvider[];
  diagnostics: boolean;
  onAccounts: () => void;
}) {
  const [report, setReport] = useState<AxisDiagnostics | null>(null);
  const [message, setMessage] = useState("");
  const [optionalHidden, setOptionalHidden] = useState(false);
  const signedIn = providers.some(
    (provider) =>
      provider.enabled && provider.installed && provider.auth.status === "authenticated",
  );
  const bridgeConnected =
    connected && (!report || report.bridgeState === "running" || report.bridgeState === "standby");
  useEffect(() => {
    if (!isPremierePanel()) return;
    let disposed = false;
    void readDiagnostics()
      .then((next) => {
        if (disposed) return;
        setReport(next);
        setMessage(
          next ? "" : "Diagnostics could not be read. Close and reopen Axis, then try again.",
        );
      })
      .catch(() => {
        if (!disposed)
          setMessage(
            "The Premiere bridge did not respond. Close and reopen Axis, then check again.",
          );
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function checkAgain() {
    setMessage("Checking local setup...");
    try {
      const next = await readDiagnostics();
      setReport(next);
      setMessage(
        next
          ? "Setup checked."
          : "Diagnostics could not be read. Close and reopen Axis, then try again.",
      );
    } catch {
      setMessage("The Premiere bridge did not respond. Close and reopen Axis, then check again.");
    }
  }

  const needsSetup =
    !ready ||
    !bridgeConnected ||
    !signedIn ||
    (!optionalHidden && report !== null && (!report.python.whisperx || !report.ffmpeg));
  if (!diagnostics && !needsSetup) return null;
  const text = JSON.stringify(
    {
      ...report,
      backendConnection: ready ? "connected" : "disconnected",
      cepBridge: bridgeConnected ? "connected" : "disconnected",
      providers: providers.map((provider) => ({
        name: provider.displayName || provider.instanceId,
        installed: provider.installed,
        enabled: provider.enabled,
        signIn: provider.auth.status,
      })),
    },
    null,
    2,
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Report copied. It includes local paths; review it before sharing with support.");
    } catch {
      setMessage("Select the report below and press Ctrl+C to copy it.");
    }
  }
  return (
    <section data-axis-setup="" aria-label={diagnostics ? "Diagnostics" : "Axis setup"}>
      <h2>{diagnostics ? "Diagnostics" : "Let's get Axis ready"}</h2>
      {diagnostics ? (
        <>
          <p>
            Versions, paths and sign-in status are included. Credentials and conversations are
            excluded.
          </p>
          <button type="button" onClick={() => void copy()}>
            Copy report
          </button>
          <pre tabIndex={0} aria-label="Support report">
            {text}
          </pre>
        </>
      ) : null}
      <details open={!diagnostics}>
        <summary>Setup checklist and transcription setup</summary>
        <ul>
          <li>
            <strong>Backend: {ready ? "Connected" : "Needs attention"}</strong>
            {!ready ? (
              <p>
                Close and reopen Axis to restart its local backend. If it still cannot connect,
                check Windows Security &gt; Protection history, then reinstall Axis. Your
                conversations are kept.
              </p>
            ) : null}
          </li>
          <li>
            <strong>Account: {signedIn ? "Signed in" : "Connect an account"}</strong>
            {!signedIn ? (
              <>
                <p>
                  Open Accounts, install a supported provider if prompted, then sign in. Axis
                  includes Node and Git for its workspace. For Claude, also install Git for Windows
                  with Git Bash from gitforwindows.org, then restart Premiere.
                </p>
                <button type="button" onClick={onAccounts}>
                  Open account setup
                </button>
              </>
            ) : null}
          </li>
          <li>
            <strong>Premiere bridge: {bridgeConnected ? "Connected" : "Needs attention"}</strong>
            {!bridgeConnected ? (
              <>
                <p>
                  Open Axis from Window &gt; Extensions in Premiere Pro. Close and reopen the panel,
                  or restart Premiere after installation.
                </p>
                <button type="button" onClick={() => void requestPremiereContext()}>
                  Retry bridge
                </button>
              </>
            ) : null}
          </li>
          <li>
            <strong>
              Transcription:{" "}
              {report
                ? report.python.whisperx && report.ffmpeg
                  ? "Installed"
                  : "Optional setup"
                : "Checking Python and WhisperX"}
            </strong>
            {!report?.python.whisperx || !report.ffmpeg ? (
              <>
                <p>
                  For local transcription, install Python 3.12 from python.org with the Python
                  launcher enabled. In PowerShell run:
                </p>
                <code>py -3.12 -m pip install whisperx</code>
                <p>
                  Install FFmpeg from ffmpeg.org and add its bin folder to your user PATH. Check it
                  with <code>ffmpeg -version</code>.
                </p>
                <p>
                  Restart Premiere, then check again. CPU transcription works without an NVIDIA GPU.
                  You can also import an existing SRT, VTT or WhisperX JSON transcript.
                </p>
              </>
            ) : null}
          </li>
        </ul>
      </details>
      <button type="button" onClick={() => void checkAgain()}>
        Check again
      </button>
      {!diagnostics && ready && bridgeConnected && signedIn ? (
        <button type="button" onClick={() => setOptionalHidden(true)}>
          Hide optional setup
        </button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
