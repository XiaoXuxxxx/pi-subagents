import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const viewers: ConversationViewer[] = [];

function render(overrides: Partial<AgentRecord>, activity?: AgentActivity) {
  const tui = { mode: "regular", terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() };
  const record: AgentRecord = {
    id: "external", type: "internet", runner: "agy", description: "Research sources", status: "completed",
    toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
    ...overrides,
  };
  const viewer = new ConversationViewer(tui as unknown as TUI, undefined, record, activity, theme, vi.fn());
  viewers.push(viewer);
  return viewer.render(120).join("\n");
}

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
});

describe("Antigravity output after settlement", () => {
  it.each(["completed", "stopped", "error"] as const)("opens %s output without a live activity tracker", status => {
    const error = status === "error" ? "CLI failed." : undefined;
    const output = render({ status, result: "Retained output.", error });
    expect(output).toContain("Retained output.");
    if (error) expect(output).toContain(error);
    expect(output).not.toContain("Enter steer");
    expect(output).not.toContain("x stop");
  });

  it("renders partial output alongside a runner failure", () => {
    const activity: AgentActivity = { activeTools: new Map(), toolUses: 0, turnCount: 1, responseText: "Partial findings." };
    const output = render({ status: "error", error: "Process exited before a result." }, activity);
    expect(output).toContain("Partial findings.");
    expect(output).toContain("Process exited before a result.");
  });

  it("does not leave an empty failed run looking as though it is still waiting", () => {
    const output = render({ status: "error", error: "Cannot run agy: ENOENT" });
    expect(output).toContain("Cannot run agy: ENOENT");
    expect(output).not.toContain("waiting for output");
  });
});
