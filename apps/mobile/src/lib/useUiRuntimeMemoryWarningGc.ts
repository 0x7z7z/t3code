import { useEffect } from "react";
import { AppState } from "react-native";
import { scheduleOnUI } from "react-native-worklets";

function collectUiRuntimeGarbage() {
  "worklet";
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

/**
 * iOS memory warnings collect only RN's JS heap. Collect the separate worklet heap too, or its
 * shadow nodes and serializables stay alive.
 */
export function useUiRuntimeMemoryWarningGc() {
  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      scheduleOnUI(collectUiRuntimeGarbage);
    });
    return () => subscription.remove();
  }, []);
}
