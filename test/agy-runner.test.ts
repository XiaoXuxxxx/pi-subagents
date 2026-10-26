import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgyAgent } from "../src/agy-runner.js";
import type { AgentConfig } from "../src/types.js";

const config: AgentConfig = {
  name: "media", runner: "agy", description: "Analyze media", systemPrompt: "Describe supplied media.",
  extensions: false, skills: false, builtinToolNames: [], promptMode: "replace",
};
let cwd: string;
function scenario(value: Record<string, unknown>) {
  writeFileSync(join(cwd, "scenario.json"), JSON.stringify(value));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-agy-test-"));
  vi.stubEnv("PATH", `${cwd}:${process.env.PATH}`);
  writeFileSync(join(cwd, "agy"), `#!${process.execPath}
const fs = require("node:fs");
const {spawn} = require("node:child_process");
const s = JSON.parse(fs.readFileSync("scenario.json", "utf8"));
fs.writeFileSync("request.json", JSON.stringify({args: process.argv.slice(2), env: process.env}));
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (s.block) {
  process.on("SIGTERM", () => process.exit(0));
  const code = 'process.on("SIGTERM", () => {}); console.log(JSON.stringify({event:"step_update",step_update:{text_delta:"ready"}})); setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ["-e", code], {detached: !!s.escape, stdio: ["ignore", "inherit", "inherit"]});
  fs.writeFileSync("child.pid", String(child.pid));
  setInterval(() => {}, 1000);
} else if (s.raw) {
  process.stdout.write(s.raw);
  process.exitCode = s.code || 0;
} else {
  emit({event:"init", init:{model:"gemini"}});
  emit({event:"step_update",step_update:{state:"ACTIVE",tool_name:"read_file",text_delta:"Looking"}});
  emit({event:"step_update",step_update:{state:"DONE",tool_name:"read_file"}});
  emit({event:"result",result:{status:s.status || "SUCCESS",response:"A red square.",usage:{input_tokens:12,output_tokens:5,thinking_tokens:2,cache_read_tokens:3}}});
  process.exitCode = s.code || 0;
}
`, { mode: 0o700 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

describe("direct agy runner", () => {
  it("streams activity, returns the final response, and forwards only CLI environment settings", async () => {
    scenario({});
    vi.stubEnv("PI_AGY_TEST_SECRET", "do-not-forward");
    vi.stubEnv("GEMINI_API_KEY", "test-cli-key");
    const text: string[] = [];
    const tools: string[] = [];
    const usage = vi.fn();
    const result = await runAgyAgent({ ...config, agyModel: "chosen-model" }, "Inspect '/tmp/a b.png'; $(touch nope)", {
      cwd, onTextDelta: (_, full) => text.push(full),
      onToolActivity: a => tools.push(`${a.type}:${a.toolName}`), onAssistantUsage: usage,
    });
    expect(result).toEqual({ responseText: "A red square.", aborted: false, steered: false, failure: undefined });
    expect(text).toEqual(["Looking", "A red square."]);
    expect(tools).toEqual(["start:read_file", "end:read_file"]);
    expect(usage).toHaveBeenCalledWith({ input: 12, output: 7, cacheRead: 3, cacheWrite: 0 });
    const request = JSON.parse(readFileSync(join(cwd, "request.json"), "utf8"));
    expect(request.args.slice(-2)).toEqual(["-p", "Describe supplied media.\n\nTask:\nInspect '/tmp/a b.png'; $(touch nope)"]);
    expect(request.args).toContain("chosen-model");
    expect(request.args).toContain("plan");
    expect(request.args).not.toContain("--dangerously-skip-permissions");
    expect(request.env.PI_AGY_TEST_SECRET).toBeUndefined();
    expect(request.env.GEMINI_API_KEY).toBe("test-cli-key");
  });

  it("adds permission bypass only when explicitly enabled", async () => {
    scenario({});
    await runAgyAgent({ ...config, agySkipPermissions: true }, "inspect", { cwd });
    const request = JSON.parse(readFileSync(join(cwd, "request.json"), "utf8"));
    expect(request.args).toContain("--dangerously-skip-permissions");
  });

  it.each([
    [{ status: "ERROR" }, "agy failed (ERROR)."],
    [{ code: 3 }, "agy exited with code 3."],
    [{ raw: '{"event":"init"}\n' }, "agy exited without a result."],
    [{ raw: "not-json\n" }, "agy emitted invalid stream-json."],
    [{ raw: '{"event":"result","result":{"status":"SUCCESS"}}\n' }, "agy result has no response."],
  ])("does not report a failed or malformed run as completed: %j", async (value, message) => {
    scenario(value);
    const result = await runAgyAgent(config, "inspect", { cwd });
    expect(result.failure).toBe(message);
  });

  it.each(["\0", "x".repeat(100_001)])("rejects invalid prompts before spawning", async (prompt) => {
    await expect(runAgyAgent(config, prompt, { cwd })).rejects.toThrow("prompt must be NUL-free");
    expect(() => readFileSync(join(cwd, "request.json"))).toThrow();
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runAgyAgent(config, "inspect", { cwd, signal: controller.signal })).toMatchObject({ aborted: true });
    expect(() => readFileSync(join(cwd, "request.json"))).toThrow();
  });

  it("contains progress callback failures instead of throwing from a stream event", async () => {
    scenario({});
    let first = true;
    const result = await runAgyAgent(config, "inspect", { cwd, onTextDelta: () => {
      if (first) { first = false; throw new Error("reporter failed"); }
    } });
    expect(result.failure).toContain("Cannot process agy progress: Error: reporter failed");
  });

  it("reports a missing CLI as a failed run", async () => {
    vi.stubEnv("PATH", join(cwd, "no-binaries"));
    const result = await runAgyAgent(config, "inspect", { cwd });
    expect(result.failure).toMatch(/Cannot run agy:.*ENOENT/);
  });

  it("enforces the outer deadline independently of the CLI timeout", async () => {
    scenario({ block: true });
    vi.useFakeTimers();
    let ready: () => void = () => {};
    const started = new Promise<void>(resolve => { ready = resolve; });
    const run = runAgyAgent(config, "inspect", { cwd, onTextDelta: ready });
    await started;
    vi.advanceTimersByTime(10 * 60_000);
    vi.advanceTimersByTime(1000);
    const result = await run;
    expect(result.aborted).toBe(false);
    expect(result.failure).toContain("agy timed out after 10 minutes.");
  }, 5000);

  it("settles cancellation even when an escaped descendant holds the output pipes", async () => {
    scenario({ block: true, escape: true });
    const controller = new AbortController();
    try {
      const result = await runAgyAgent(config, "inspect", {
        cwd, signal: controller.signal, onTextDelta: () => controller.abort(),
      });
      expect(result.aborted).toBe(true);
    } finally {
      // This child deliberately escapes the runner's process group: the test owns it.
      const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
    }
  }, 5000);

  it("stops a process group even when the leader exits and a descendant ignores SIGTERM", async () => {
    scenario({ block: true });
    const controller = new AbortController();
    const run = runAgyAgent(config, "inspect", {
      cwd, signal: controller.signal, onTextDelta: () => controller.abort(),
    });
    const result = await run;
    expect(result.aborted).toBe(true);
    const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
    // Pipe EOF can precede the kernel's zombie transition; wait for process completion.
    await vi.waitFor(() => {
      let state: string | undefined;
      try {
        process.kill(pid, 0);
        state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1];
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toMatch(/^(ESRCH|ENOENT)$/);
      }
      if (state !== undefined) expect(state.startsWith("Z ")).toBe(true);
    }, { timeout: 1000, interval: 10 });
  }, 5000);
});
