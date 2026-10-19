import { useLayoutEffect, useRef, useState } from "react";

/** Call only from handlers and effects; render sees the previous commit's fn.
 * The stable forwarder avoids retaining V8's shared render closure scope. */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  );
  return stable;
}
