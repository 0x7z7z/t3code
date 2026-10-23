import { isPremierePanel } from "./premiere/host";

export function isLocalEnvironmentDisabled(): boolean {
  // A file-backed CEP parent cannot use the web app's SameSite browser cookie.
  // The panel pairs through T3's existing bearer-based connection flow instead.
  return isPremierePanel() || window.desktopBridge?.getLocalEnvironmentEnabled?.() === false;
}
