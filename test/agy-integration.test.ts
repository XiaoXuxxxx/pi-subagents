import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { runAgyAgent } from "../src/agy-runner.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { runMentionClone } from "../src/mention-clone.js";
import { checkModelScope } from "../src/model-scope.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import type { AgentConfig } from "../src/types.js";
import { FleetList } from "../src/ui/fleet-list.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), runAgent: vi.fn(), resumeAgent: vi.fn(),
}));
vi.mock("../src/agy-runner.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), runAgyAgent: vi.fn(),
}));
vi.mock("../src/model-scope.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), checkModelScope: vi.fn(() => ({ kind: "ok" })),
}));
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

const config: AgentConfig = {
  name: "media", description: "Media research", runner: "agy", systemPrompt: "Research media.",
  promptMode: "replace", builtinToolNames: [], extensions: false, skills: false,
  agyModel: "flash", agySkipPermissions: true,
};
type Result = Awaited<ReturnType<typeof runAgyAgent>>;
const done: Result = { responseText: "external answer", aborted: false, steered: false };
const pi = {} as ExtensionAPI;
const context = { cwd: "/tmp" } as ExtensionContext;
let manager: AgentManager;
let hermetic: Hermetic | undefined;
let shutdown: (() => Promise<void>) | undefined;
let finishes: ((result: Result) => void)[];

function holdRun() {
  let finish!: (result: Result) => void;
  const promise = new Promise<Result>(resolve => { finish = resolve; });
  finishes.push(finish);
  vi.mocked(runAgyAgent).mockReturnValueOnce(promise);
  return finish;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runAgyAgent).mockReset().mockResolvedValue(done);
  finishes = [];
  registerAgents(new Map([[config.name, { ...config }]]));
});
afterEach(async () => {
  for (const finish of finishes) finish(done);
  await shutdown?.();
  shutdown = undefined;
  await manager?.dispose();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
  registerAgents(new Map());
  vi.useRealTimers();
});

describe("agy manager lifecycle", () => {
  it("starts directly, returns before completion, and uses ordinary completion/activity/usage callbacks", async () => {
    const complete = vi.fn();
    const started = vi.fn();
    const usage = vi.fn();
    const created = vi.fn();
    manager = new AgentManager(complete, 1, started, undefined, usage);
    const finish = holdRun();
    const id = manager.spawn(pi, context, "media", "find images", { description: "research", isBackground: true, onSessionCreated: created });
    const record = manager.getRecord(id)!;
    expect(started).toHaveBeenCalledWith(record);
    expect(record.status).toBe("running");
    expect(complete).not.toHaveBeenCalled();
    expect(runAgyAgent).toHaveBeenCalledWith(record.agyConfig, "find images", expect.objectContaining({ cwd: "/tmp", signal: record.abortController!.signal }));
    const options = vi.mocked(runAgyAgent).mock.calls[0][2];
    options.onToolActivity?.({ type: "end", toolName: "search" });
    options.onAssistantUsage?.({ input: 10, output: 20, cacheRead: 3, cacheWrite: 0 });
    finish(done);
    await record.promise;
    expect(record).toMatchObject({ runner: "agy", status: "completed", result: done.responseText, toolUses: 1, lifetimeUsage: { input: 10, output: 20 } });
    expect(record.session).toBeUndefined();
    expect(created).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledWith(record, expect.objectContaining({ input: 10 }));
    expect(complete).toHaveBeenCalledWith(record);
  });

  it("queues in the existing pool, stops queued work, and captures config before a reload", async () => {
    manager = new AgentManager(undefined, 1);
    const finish = holdRun();
    const first = manager.spawn(pi, context, "media", "first", { description: "first", isBackground: true });
    const second = manager.spawn(pi, context, "media", "second", { description: "second", isBackground: true });
    const stopped = manager.spawn(pi, context, "media", "third", { description: "third", isBackground: true });
    expect(manager.getRecord(second)?.status).toBe("queued");
    expect(runAgyAgent).toHaveBeenCalledTimes(1);
    expect(manager.abort(stopped)).toBe(true);
    registerAgents(new Map([[config.name, { ...config, runner: "pi", systemPrompt: "changed", isolation: "worktree" }]]));
    finish(done);
    await manager.getRecord(first)!.promise;
    await manager.waitForAll();
    expect(runAgyAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgyAgent).mock.calls[1][0]).toEqual({ systemPrompt: config.systemPrompt, agyModel: "flash", agySkipPermissions: true });
    expect(manager.getRecord(second)?.status).toBe("completed");
    expect(manager.getRecord(stopped)?.status).toBe("stopped");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([{ ...done, aborted: true }, { ...done, failure: "process failed" }])("keeps an explicit stop over runner settlement %j", async result => {
    manager = new AgentManager();
    const finish = holdRun();
    const id = manager.spawn(pi, context, "media", "task", { description: "task", isBackground: true });
    expect(manager.abort(id)).toBe(true);
    finish(result);
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)).toMatchObject({ status: "stopped", result: done.responseText });
  });

  it.each([{ model: {} }, { parentAgentId: "parent" }, { isolation: "worktree" as const }])("rejects unsupported options without records or callbacks: %j", options => {
    const start = vi.fn();
    const queued = vi.fn();
    manager = new AgentManager(undefined, 1, start);
    expect(() => manager.spawn(pi, context, "media", "task", { description: "task", ...options, onQueued: queued })).toThrow(/agy runner does not support/);
    expect(manager.listAgents()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(queued).not.toHaveBeenCalled();
    expect(runAgyAgent).not.toHaveBeenCalled();
  });

  it("refuses an unknown runner rather than running Pi", () => {
    manager = new AgentManager();
    registerAgents(new Map([[config.name, { ...config, runner: "unknown" }]]));
    expect(() => manager.spawn(pi, context, "media", "task", { description: "task" })).toThrow(/Unknown agent runner/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects steering and resume without queuing messages or creating a session", async () => {
    manager = new AgentManager();
    const finish = holdRun();
    const id = manager.spawn(pi, context, "media", "task", { description: "task" });
    expect(manager.steer(id, "change course")).toBe(false);
    await expect(manager.resume(id, "continue")).rejects.toThrow(/agy.*resume/);
    expect(manager.getRecord(id)?.pendingSteers).toBeUndefined();
    finish(done);
    await manager.getRecord(id)!.promise;
    await expect(manager.resume(id, "continue")).rejects.toThrow(/agy.*resume/);
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("delivers failures through shared settlement and consumes inline results", async () => {
    const complete = vi.fn();
    manager = new AgentManager(complete);
    vi.mocked(runAgyAgent).mockResolvedValueOnce({ ...done, failure: "process failed" });
    const { record } = await manager.spawnAndWait(pi, context, "media", "task", { description: "task" });
    expect(record).toMatchObject({ status: "error", result: done.responseText, error: "process failed", resultConsumed: true });
    expect(complete).toHaveBeenCalledWith(record);
  });

  it("aborts and awaits external shutdown without late completion notifications", async () => {
    const complete = vi.fn();
    manager = new AgentManager(complete);
    const finish = holdRun();
    const id = manager.spawn(pi, context, "media", "task", { description: "task", isBackground: true });
    const signal = manager.getRecord(id)!.abortController!.signal;
    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await flush();
    expect(signal.aborted).toBe(true);
    expect(disposed).toBe(false);
    finish(done);
    await disposal;
    expect(complete).not.toHaveBeenCalled();
  });

  it("bounds shutdown even when an external runner fails to settle", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    manager = new AgentManager(complete);
    const finish = holdRun();
    manager.spawn(pi, context, "media", "task", { description: "task", isBackground: true });
    const disposal = manager.dispose();
    await vi.advanceTimersByTimeAsync(3000);
    await disposal;
    vi.useRealTimers();
    finish(done);
    await flush();
    expect(complete).not.toHaveBeenCalled();
  });
});

function boot() {
  hermetic = hermeticDir({ agentFiles: { media: "---\nrunner: agy\nagy_skip_permissions: true\n---\nResearch media." } });
  const booted = makePi();
  subagentsExtension(booted.pi);
  shutdown = () => booted.lifecycle.get("session_shutdown")();
  return booted;
}

describe("agy entrypoints", () => {
  it("starts via Agent without Pi model policy or a misleading transcript, and fetches the full result", async () => {
    const { tools, pi: api } = boot();
    const finish = holdRun();
    const call = ctx({ model: { id: "parent-pi-model", provider: "test" } });
    const result = await tools.get("Agent").execute("call", { subagent_type: "media", description: "research", prompt: "find images" }, undefined, undefined, call);
    const id = result.details.agentId;
    expect(textOf(result)).toContain("started in background");
    expect(tools.get("Agent").description).toContain("Runner: agy — external CLI tools");
    expect(textOf(result)).not.toContain("Output file:");
    expect(result.details.modelName).toBeUndefined();
    expect(checkModelScope).not.toHaveBeenCalled();
    finish(done);
    await flush();
    const fetched = await tools.get("get_subagent_result").execute("fetch", { agent_id: id, verbose: true }, undefined, undefined, call);
    expect(textOf(fetched)).toContain(done.responseText);
    expect(api.events.emit).toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id, result: done.responseText }));
    expect(api.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id, status: "completed" }));
    await expect(tools.get("Agent").execute("resume", { subagent_type: "media", description: "resume", prompt: "continue", resume: id }, undefined, undefined, call)).rejects.toThrow(/agy.*resume/);
    await expect(tools.get("steer_subagent").execute("steer", { agent_id: id, message: "redirect" }, undefined, undefined, call)).rejects.toThrow(/agy.*steering/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("bypasses the mention clone and refuses subsequent mentions instead of silently restarting", async () => {
    const { lifecycle } = boot();
    const finish = holdRun();
    const call = ctx();
    const input = () => lifecycle.get("input")({ text: "@media find images", source: "interactive" }, call);
    expect(await input()).toEqual({ action: "handled" });
    expect(runMentionClone).not.toHaveBeenCalled();
    await input();
    finish(done);
    await flush();
    await input();
    expect(runAgyAgent).toHaveBeenCalledTimes(1);
    expect(call.ui.notify).toHaveBeenCalledWith(expect.stringContaining("does not support steering or continuation"), "warning");
  });

  it("supports foreground execution and reachable /agents stop without a Pi session", async () => {
    const { tools, commands } = boot();
    const call = ctx();
    const inline = await tools.get("Agent").execute("inline", { subagent_type: "media", description: "inline", prompt: "task", run_in_background: false }, undefined, undefined, call);
    expect(textOf(inline)).toContain(done.responseText);
    expect(inline.details.status).toBe("completed");
    holdRun();
    await tools.get("Agent").execute("background", { subagent_type: "media", description: "background", prompt: "task" }, undefined, undefined, call);
    call.ui.select = vi.fn()
      .mockImplementationOnce(async (_title, choices: string[]) => choices.find(s => s.startsWith("Running agents")))
      .mockImplementationOnce(async (_title, choices: string[]) => choices.find(s => s.includes("background")))
      .mockResolvedValueOnce("Stop").mockResolvedValue(undefined);
    await commands.get("agents").handler("", call);
    expect(vi.mocked(runAgyAgent).mock.calls[1][2].signal?.aborted).toBe(true);
    expect(call.ui.notify).toHaveBeenCalledWith('Stopped "background".', "info");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("validates RPC targets before Pi model resolution and starts supported external calls", async () => {
    manager = new AgentManager();
    const handlers = new Map<string, (data: unknown) => Promise<void>>();
    const events = { on: (name: string, fn: (data: unknown) => Promise<void>) => { handlers.set(name, fn); return () => {}; }, emit: vi.fn() };
    registerAgents(new Map([[config.name, { ...config, runner: "pi" }]]));
    registerRpcHandlers({ events, pi, getCtx: () => context, reloadAgents: () => registerAgents(new Map([[config.name, { ...config }]])), manager: {
      spawn: manager.spawn.bind(manager), awaitStartup: manager.awaitStartup.bind(manager),
      abort: manager.abort.bind(manager), getRecord: manager.getRecord.bind(manager), consumeResult: () => false,
    } });
    const spawn = handlers.get("subagents:rpc:spawn")!;
    await spawn({ requestId: "bad", type: "media", prompt: "task", options: { model: "unavailable" } });
    expect(events.emit).toHaveBeenCalledWith("subagents:rpc:spawn:reply:bad", { success: false, error: expect.stringContaining("agy runner") });
    expect(manager.listAgents()).toEqual([]);
    await spawn({ requestId: "good", type: "media", prompt: "task" });
    expect(events.emit).toHaveBeenCalledWith("subagents:rpc:spawn:reply:good", { success: true, data: { id: expect.any(String) } });
    expect(runAgyAgent).toHaveBeenCalledTimes(1);
    expect(checkModelScope).not.toHaveBeenCalled();
  });

  it("rejects workflow/scheduled targets before spawning or persisting, including jobs changed to agy", async () => {
    vi.useFakeTimers();
    const { tools, pi: api } = boot();
    const call = ctx();
    manager = new AgentManager();
    const nested = createNestedSubagentTools({ manager, pi: api, parentAgentId: "parent", depth: 1, maxSubagentDepth: 2, allowedSubagents: "all", configCwd: hermetic!.dir });
    const nestedResult = await nested[0].execute("child", { subagent_type: "media", prompt: "task", description: "research", model: "unavailable" }, undefined, undefined, call);
    expect(nestedResult).toMatchObject({ isError: true });
    expect(textOf(nestedResult)).toContain("nested/workflow");
    const host = createWorkflowHost({ pi: api, ctx: call, manager });
    expect(await host.spawnAgent({ agentId: "child", agentType: "media", label: "research", prompt: "task", model: "unavailable" })).toMatchObject({ ok: false, error: expect.stringContaining("nested/workflow") });
    await expect(tools.get("Agent").execute("schedule", { subagent_type: "media", description: "later", prompt: "task", schedule: "1h", model: "unavailable" }, undefined, undefined, call)).rejects.toThrow(/agy runner/);
    const scheduler = new SubagentScheduler();
    const store = new ScheduleStore(`${hermetic!.dir}/jobs.json`);
    scheduler.start(api, call, manager, store);
    try {
      expect(() => scheduler.addJob({ name: "refused", description: "task", subagent_type: "media", prompt: "task", schedule: "1h" })).toThrow(/scheduling/);
      expect(store.list()).toEqual([]);
      registerAgents(new Map([[config.name, { ...config, runner: "pi" }]]));
      const old = scheduler.addJob({ name: "old", description: "task", subagent_type: "media", prompt: "task", schedule: "1h", model: "unavailable" });
      registerAgents(new Map([[config.name, { ...config }]]));
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(store.get(old.id)).toMatchObject({ lastStatus: "error", runCount: 0 });
      expect(manager.listAgents()).toEqual([]);
      expect(runAgyAgent).not.toHaveBeenCalled();
      expect(checkModelScope).not.toHaveBeenCalled();
    } finally { scheduler.stop(); }
  });

  it("keeps a sessionless agy task in FleetList and explains the unsupported viewer", () => {
    manager = new AgentManager();
    holdRun();
    const id = manager.spawn(pi, context, "media", "task", { description: "research", isBackground: true });
    const call = ctx();
    call.ui.onTerminalInput = vi.fn(() => vi.fn());
    const fleet = new FleetList(manager, new Map());
    fleet.setUICtx(call.ui);
    try {
      fleet.update();
      expect(call.ui.setWidget).toHaveBeenCalledWith("fleet", expect.any(Function), { placement: "belowEditor" });
      call.ui.getEditorText = () => "";
      fleet.handleKey("\x1b[B");
      fleet.handleKey("\x1b[B");
      fleet.handleKey("\r");
      expect(call.ui.notify).toHaveBeenCalledWith(expect.stringContaining("agy conversation viewer is unsupported"), "info");
      expect(manager.getRecord(id)?.status).toBe("running");
    } finally { fleet.dispose(); }
  });
});
