import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { Markdown } from "./Markdown";
import type { TimelineActions } from "./interactiveHost";
import "./styles.css";

function actions(): TimelineActions {
  return {
    sequenceId: "seq",
    fps: 24,
    canAddMarkers: true,
    clips: [
      { name: "Hero", nodeId: "1", trackType: "V", trackIndex: 0, start: 1, end: 3 },
      { name: "Hero closeup.mov", nodeId: "2", trackType: "V", trackIndex: 0, start: 4, end: 6 },
      { name: "Hero", nodeId: "3", trackType: "A", trackIndex: 0, start: 1, end: 3 },
      { name: "ab", nodeId: "4", trackType: "V", trackIndex: 0, start: 7, end: 8 },
    ],
    select: vi.fn(async () => {}),
    addMarkers: vi.fn(async () => {}),
    seek: vi.fn(),
  };
}

it("links longest clip names and exact code spans, excluding links, code blocks and short names", async () => {
  const timeline = actions();
  // Markdown is embedded in the CEP transcript without router navigation.
  await using screen = await render(
    <Markdown
      actions={timeline}
      text={
        "Hero closeup.mov **Hero** `Hero` `Hero extra` [Hero](https://example.com) **[Hero](https://example.com/bold)** [Hero](mailto:editor@example.com) Heroic hero ab\n```\nHero\n```"
      }
    />,
    { router: false },
  );
  await expect
    .element(screen.getByRole("button", { name: "Select Hero closeup.mov in the timeline" }))
    .toBeVisible();
  expect(
    screen.getByRole("button", { name: "Select Hero in the timeline", exact: true }).elements(),
  ).toHaveLength(2);
  expect(screen.getByRole("link", { name: "Hero" }).elements()).toHaveLength(2);
  await screen
    .getByRole("button", { name: "Select Hero in the timeline", exact: true })
    .first()
    .click();
  expect(timeline.select).toHaveBeenCalledWith(timeline.clips[0]);
  await expect.element(screen.getByText("×2", { exact: false }).first()).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Select ab in the timeline" }))
    .not.toBeInTheDocument();
});

it("adds only checked markers, seeks their times, and disables after success", async () => {
  const timeline = actions();
  const source =
    '```axis-markers\n[{"time":"00:00:02:12","name":"Beat","color":"red"},{"time":4,"name":"Outro"}]\n```';
  // Suggestion cards do not navigate between app routes.
  await using screen = await render(<Markdown text={source} actions={timeline} />, {
    router: false,
  });
  await screen.getByRole("checkbox", { name: "Include marker Outro" }).click();
  await screen.getByRole("button", { name: "Move playhead to 0:02:12" }).click();
  expect(timeline.seek).toHaveBeenCalledWith(2.5);
  await screen.getByRole("button", { name: "Add 1 markers" }).click();
  expect(timeline.addMarkers).toHaveBeenCalledWith([{ time: 2.5, name: "Beat", color: "red" }]);
  await expect.element(screen.getByRole("button", { name: "Added 1 markers" })).toBeDisabled();
});

it("keeps failures inline and prevents applying a card to a changed sequence", async () => {
  const timeline = {
    ...actions(),
    addMarkers: vi.fn(async () => {
      throw new Error("Marker write failed");
    }),
  };
  const text = '```axis-markers\n[{"time":2,"name":"Beat"}]\n```';
  // Suggestion cards do not navigate between app routes.
  await using screen = await render(<Markdown text={text} actions={timeline} />, { router: false });
  await screen.getByRole("button", { name: "Add 1 markers" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Marker write failed");
  await screen.rerender(<Markdown text={text} actions={{ ...timeline, sequenceId: "another" }} />);
  await expect.element(screen.getByRole("button", { name: "Add 1 markers" })).toBeDisabled();
});

it("renders shot rows, selects sources, exports CSV and adds duration markers", async () => {
  const timeline = actions();
  const text =
    '```axis-shots\n[{"shot":"A","in":"00:00:01:00","out":"00:00:04:12","description":"Hero arrives","source":"Hero","notes":"Hold"}]\n```';
  // The table is part of the CEP transcript, with no app router.
  await using screen = await render(<Markdown text={text} actions={timeline} />, { router: false });
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await expect.element(screen.getByRole("table")).toBeVisible();
  await screen.getByRole("button", { name: "Select Hero in the timeline" }).click();
  expect(timeline.select).toHaveBeenCalledWith(timeline.clips[0]);
  await screen.getByRole("button", { name: "Move playhead to 0:04:12" }).click();
  expect(timeline.seek).toHaveBeenCalledWith(4.5);
  await screen.getByRole("button", { name: "Copy CSV" }).click();
  expect(clipboard).toHaveBeenCalledWith(
    expect.stringContaining('"A","1","4.5","3.5","Hero arrives","Hero","Hold","todo"'),
  );
  await screen.getByRole("button", { name: "Add as markers" }).click();
  expect(timeline.addMarkers).toHaveBeenCalledWith([
    { time: 1, duration: 3.5, name: "Shot A", comment: "Hero arrives\nHero\nHold", color: "blue" },
  ]);
  await expect.element(screen.getByRole("button", { name: "Added 1 markers" })).toBeDisabled();
});

it("falls back for malformed blocks and never enables streaming or unclosed suggestions", async () => {
  const timeline = actions();
  // Markdown is part of the CEP transcript, with no router.
  await using screen = await render(
    <Markdown actions={timeline} text={"```axis-markers\nnot json\n```"} />,
    { router: false },
  );
  await expect
    .element(screen.getByText("Interactive suggestion unavailable:", { exact: false }))
    .toBeVisible();
  const valid = '```axis-markers\n[{"time":1,"name":"Beat"}]';
  await screen.rerender(<Markdown actions={timeline} text={valid} />);
  await expect
    .element(screen.getByRole("button", { name: "Add 1 markers" }))
    .not.toBeInTheDocument();
  await screen.rerender(<Markdown actions={timeline} text={`${valid}\n\`\`\``} complete={false} />);
  await expect
    .element(screen.getByRole("button", { name: "Add 1 markers" }))
    .not.toBeInTheDocument();
});

it("keeps clip selection errors inline and respects editing permission for markers", async () => {
  const timeline = {
    ...actions(),
    canAddMarkers: false,
    select: vi.fn(async () => {
      throw new Error("Clip no longer exists");
    }),
  };
  // These controls live in the CEP transcript, without router navigation.
  await using screen = await render(
    <Markdown actions={timeline} text={'Hero\n```axis-markers\n[{"time":1,"name":"Beat"}]\n```'} />,
    { router: false },
  );
  await screen.getByRole("button", { name: "Select Hero in the timeline" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Clip no longer exists");
  await expect.element(screen.getByRole("button", { name: "Add 1 markers" })).toBeDisabled();
  expect(timeline.addMarkers).not.toHaveBeenCalled();
});

it.each([320, 440])("keeps a long shot table inside a %ipx panel", async (width) => {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  const text = `\`\`\`axis-shots\n${JSON.stringify([{ shot: "1", in: 1, out: 4, description: "A long description ".repeat(30), source: "A-long-source-name.mov" }])}\n\`\`\``;
  // The CEP transcript renders without router navigation.
  await using screen = await render(
    <div data-assistant-message="">
      <Markdown actions={actions()} text={text} />
    </div>,
    { container, router: false },
  );
  await expect.element(screen.getByRole("table")).toBeVisible();
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
});
