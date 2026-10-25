import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { ComposerUsage } from "./ComposerUsage";
import "./styles.css";

it.each(["codex", "claude"])(
  "shows %s account windows on hover and keyboard focus",
  async (provider) => {
    const context = deriveLatestContextWindowSnapshot([], {
      usedTokens: 24_000,
      maxTokens: 100_000,
      updatedAt: "2026-10-25T00:00:00Z",
    });
    // The CEP meter is independent of routing.
    await using screen = await render(
      <ComposerUsage
        context={context}
        account={provider}
        limits={{
          checkedAt: "2026-10-25T00:00:00Z",
          windows: [
            {
              id: provider === "codex" ? "primary" : "five_hour",
              label: "5-hour",
              kind: "session",
              usedPercent: 35,
              windowDurationMins: 300,
              resetsAt: "2026-10-25T05:00:00Z",
            },
            {
              id: provider === "codex" ? "secondary" : "seven_day",
              label: "Weekly",
              kind: "weekly",
              usedPercent: 68,
              windowDurationMins: 10_080,
              resetsAt: "2026-11-01T00:00:00Z",
            },
          ],
        }}
      />,
      { router: false },
    );
    const ring = screen.getByRole("button", { name: "Context window 24% used" });
    await userEvent.hover(ring);
    await expect.element(screen.getByRole("tooltip")).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Context window tokens" }).element().textContent,
    ).toBe("24,000 / 100,000 tokens (24%)");
    expect(screen.getByRole("status", { name: "5-hour usage" }).element().textContent).toBe(
      "35% used",
    );
    expect(screen.getByRole("status", { name: "Weekly usage" }).element().textContent).toBe(
      "68% used",
    );
    expect(screen.container.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-25T05:00:00Z",
    );
    await userEvent.unhover(ring);
    ring.element().focus();
    await expect.element(screen.getByRole("tooltip")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
  },
);

it("keeps missing context and limits neutral and clears a previous account's values", async () => {
  const context = deriveLatestContextWindowSnapshot([], {
    usedTokens: 99,
    maxTokens: 100,
    updatedAt: "2026-10-25T00:00:00Z",
  });
  // The CEP meter is independent of routing.
  await using screen = await render(
    <ComposerUsage context={context} limits={undefined} account="Codex" />,
    { router: false },
  );
  await screen.rerender(<ComposerUsage context={null} limits={undefined} account="Claude" />);
  const ring = screen.getByRole("button", { name: "Context window \u2014 used" });
  ring.element().focus();
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  expect(screen.getByRole("status", { name: "Context window tokens" }).element().textContent).toBe(
    "\u2014 / \u2014 tokens (\u2014)",
  );
  expect(screen.getByRole("status", { name: "5-hour usage" }).element().textContent).toBe("\u2014");
  expect(screen.getByRole("status", { name: "Weekly usage" }).element().textContent).toBe("\u2014");
  expect(ring.element().parentElement?.getAttribute("data-usage-level")).toBe("unknown");
});

it.each([
  [80, "normal"],
  [81, "amber"],
  [95, "amber"],
  [96, "red"],
] as const)("colours %i percent context usage %s", async (usedTokens, level) => {
  const context = deriveLatestContextWindowSnapshot([], {
    usedTokens,
    maxTokens: 100,
    updatedAt: "2026-10-25T00:00:00Z",
  });
  // The CEP meter is independent of routing.
  await using screen = await render(
    <ComposerUsage context={context} limits={undefined} account="Codex" />,
    { router: false },
  );
  expect(screen.getByRole("button").element().parentElement?.getAttribute("data-usage-level")).toBe(
    level,
  );
});
