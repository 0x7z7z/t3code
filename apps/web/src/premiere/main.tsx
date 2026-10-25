import "core-js/actual";
import ReactDOM from "react-dom/client";
import { Component, type ReactNode } from "react";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { PremiereApp } from "./PremiereApp";
import { installPremiereHostBridge } from "./host";
import "./styles.css";

const release = installPremiereHostBridge();
window.addEventListener("pagehide", release, { once: true });
class PanelRecovery extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <section data-axis-setup="" role="alert">
        <h2>Let's reopen your workspace</h2>
        <p>
          Axis could not display this workspace. Your saved conversations are kept. Close and reopen
          the panel, or click Reload. If this continues, use the outer Menu &gt; Diagnostics to copy
          a support report.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <PanelRecovery>
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>
  </PanelRecovery>,
);
