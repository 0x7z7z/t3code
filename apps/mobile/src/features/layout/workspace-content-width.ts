import { createContext, use } from "react";
import type { SharedValue } from "react-native-reanimated";

// Controls follow the visible pane; keep the expensive navigator/feed at settled width during transitions.
export const WorkspaceContentWidthContext = createContext<SharedValue<number> | null>(null);

export function useWorkspaceContentWidth() {
  return use(WorkspaceContentWidthContext);
}
