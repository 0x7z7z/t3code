import type { ReactNode, RefObject } from "react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { View, type ViewInstance } from "react-native";

type ComposerPopoverHostValue = {
  readonly hostRef: RefObject<ViewInstance | null>;
  readonly setContent: (content: ReactNode) => void;
  readonly layoutVersion: number;
};

const ComposerPopoverHostContext = createContext<ComposerPopoverHostValue | null>(null);

export function useComposerPopoverHost() {
  return useContext(ComposerPopoverHostContext);
}

/**
 * Mount inside KeyboardStickyView so Android can deliver gestures within the host's bounds.
 * Hide with the composer explicitly: portal content lives outside its subtree.
 */
export function ComposerPopoverHost(props: {
  readonly hidden: boolean;
  readonly children: ReactNode;
}) {
  const hostRef = useRef<ViewInstance>(null);
  const [content, setContent] = useState<ReactNode>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const value = useMemo(() => ({ hostRef, setContent, layoutVersion }), [layoutVersion]);

  return (
    <ComposerPopoverHostContext.Provider value={value}>
      <View
        ref={hostRef}
        collapsable={false}
        pointerEvents="box-none"
        className="absolute inset-0"
        onLayout={() => setLayoutVersion((version) => version + 1)}
      >
        {props.children}
        {props.hidden ? null : content}
      </View>
    </ComposerPopoverHostContext.Provider>
  );
}
