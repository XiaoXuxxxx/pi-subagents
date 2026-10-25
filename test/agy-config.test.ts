import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAgentRunner } from "../src/agy-runner.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import type { AgentConfig } from "../src/types.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-agy-config-"));
  vi.stubEnv("HOME", cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "global"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

function agent(fields = ""): AgentConfig {
  writeFileSync(join(cwd, ".pi", "agents", "media.md"), `---\nrunner: agy\n${fields}\n---\nAnalyze the supplied media.\n`);
  const loaded = loadCustomAgents(cwd, true, { packageDirs: [], packageFiles: [] }).get("media");
  if (!loaded) throw new Error("fixture did not load");
  return loaded;
}

describe("agy agent configuration", () => {
  it("loads the runner without inheriting Pi tools and accepts a CLI model and explicit permission grant", () => {
    const loaded = agent("agy_model: chosen-cli-model\nagy_skip_permissions: true");
    expect(loaded.runner).toBe("agy");
    expect(loaded.agyModel).toBe("chosen-cli-model");
    expect(loaded.agySkipPermissions).toBe(true);
    expect(loaded.builtinToolNames).toEqual([]);
    expect(loaded.extensions).toBe(false);
    expect(loaded.skills).toBe(false);
    expect(validateAgentRunner(loaded)).toBe(true);
  });

  it("defaults to keeping CLI permission checks enabled", () => {
    expect(agent().agySkipPermissions).toBe(false);
  });

  it.each([
    "model: openai/example", "thinking: high", "max_turns: 5", "tools: read",
    "disallowed_tools: bash", "extensions: true", "skills: true", "memory: user",
    "persist_session: true", "output_transcript: true", "session_dir: /tmp/sessions", "allowed_subagents: all",
    "inherit_context: true", "prompt_mode: append", "isolated: true", "isolation: worktree",
  ])("refuses Pi-only frontmatter instead of pretending to enforce it: %s", fields => {
    expect(() => validateAgentRunner(agent(fields))).toThrow("agy runner does not support");
  });

  it.each([
    { model: "some-model" }, { thinkingLevel: "high" }, { maxTurns: 3 }, { inheritContext: true },
    { isolated: true }, { isolation: "worktree" }, { resumeSessionFile: "/tmp/session" },
    { structuredOutput: {} }, { parentAgentId: "parent" }, { workflowId: "workflow" },
    { cwd: "/another/project" }, { schedule: "+1m" },
  ])("refuses unsupported invocation options: %j", options => {
    expect(() => validateAgentRunner(agent(), options)).toThrow("agy runner does not support");
  });

  it("does not fall back to Pi for an unknown runner", () => {
    expect(() => validateAgentRunner({ ...agent(), runner: "aggy" })).toThrow("Unknown agent runner");
  });

  it("leaves existing Pi agents on their existing path", () => {
    expect(validateAgentRunner(undefined)).toBe(false);
    expect(validateAgentRunner({ ...agent(), runner: "pi", model: "pi-model" }, { inheritContext: true })).toBe(false);
  });
});
