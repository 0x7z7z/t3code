import "core-js/actual";
import ReactDOM from "react-dom/client";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { PremiereApp } from "./PremiereApp";
import { installPremiereHostBridge } from "./host";
import "./styles.css";

const release = installPremiereHostBridge();
window.addEventListener("pagehide", release, { once: true });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <AppAtomRegistryProvider>
    <PremiereApp />
  </AppAtomRegistryProvider>,
);
