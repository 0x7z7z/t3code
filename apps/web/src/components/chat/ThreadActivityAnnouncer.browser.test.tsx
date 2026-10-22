import { RunId } from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";

const announcer = (props: Partial<ComponentProps<typeof ThreadActivityAnnouncer>>) => (
  <ThreadActivityAnnouncer
    threadKey="thread-1"
    status="working"
    activity={null}
    runId={RunId.make("run-1")}
    runStatus="running"
    {...props}
  />
);

describe("ThreadActivityAnnouncer", () => {
  it("drops a queued label once nothing is live", async () => {
    // The announcer reads no route.
    await using screen = await render(announcer({ status: "idle", runStatus: "completed" }), {
      router: false,
    });
    {
      // Restored before the assertion, which polls on real timers.
      using _timers = fakeTimers();
      await screen.rerender(announcer({}));
      await screen.rerender(announcer({ activity: "Reading ChatView.tsx" }));
      await screen.rerender(announcer({ activity: null }));
      await act(() => vi.advanceTimersByTime(5_000));
    }

    await expect.element(screen.getByRole("status")).toHaveTextContent("Working");
  });
});
