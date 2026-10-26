/** Direct Antigravity execution; no Pi session or model call. */
import { spawn } from "node:child_process";
import type { AgentConfig } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

interface AgyRunOptions {
  cwd: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string, fullText: string) => void;
  onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
}

interface AgyRunResult {
  responseText: string;
  session?: undefined;
  aborted: boolean;
  steered: false;
  failure?: string;
}

/** Validate at every entry point before Pi model resolution or task side effects. */
export function validateAgentRunner(config: AgentConfig | undefined, options: {
  model?: unknown; thinkingLevel?: unknown; maxTurns?: unknown; inheritContext?: boolean;
  isolated?: boolean; isolation?: string; resumeSessionFile?: string; structuredOutput?: unknown;
  parentAgentId?: string; workflowId?: string; cwd?: string; schedule?: string;
} = {}): boolean {
  if (config?.runner === undefined || config.runner === "pi") return false;
  if (config.runner !== "agy") throw new Error(`Unknown agent runner: ${config.runner}`);
  const unsupported = [
    options.model !== undefined || config.model !== undefined ? "model (use agy_model in the agent file)" : "",
    options.thinkingLevel !== undefined || config.thinking !== undefined ? "thinking" : "",
    options.maxTurns !== undefined || config.maxTurns !== undefined ? "max_turns" : "",
    options.inheritContext || config.inheritContext || config.promptMode === "append" ? "inherited context/prompt" : "",
    options.isolated || config.isolated || options.isolation === "worktree" || config.isolation === "worktree" ? "Pi isolation" : "",
    options.resumeSessionFile ? "resume" : "",
    options.structuredOutput !== undefined ? "structured output" : "",
    options.parentAgentId || options.workflowId || config.allowedSubagents ? "nested/workflow agents" : "",
    options.cwd ? "custom cwd" : "",
    options.schedule ? "scheduling" : "",
    config.memory || config.persistSession || config.sessionDir || config.outputTranscript ? "Pi session/memory/transcript" : "",
    config.builtinToolNames?.length || config.extSelectors?.length || config.disallowedTools?.length
      || config.excludeExtensions?.length || config.extensions !== false || config.skills !== false ? "Pi tool/extension/skill controls" : "",
  ].filter(Boolean);
  if (unsupported.length) throw new Error(`agy runner does not support: ${unsupported.join(", ")}.`);
  return true;
}

const TIMEOUT_MS = 10 * 60_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export async function runAgyAgent(config: Pick<AgentConfig, "systemPrompt" | "agyAgent" | "agyModel" | "agySkipPermissions">, prompt: string, options: AgyRunOptions): Promise<AgyRunResult> {
  if (options.signal?.aborted) {
    return { responseText: "", aborted: true, steered: false };
  }
  // CLI print mode receives one argument: stay below Linux's per-argument limit.
  const task = `${config.systemPrompt}\n\nTask:\n${prompt}`;
  if (task.includes("\0") || Buffer.byteLength(task) > 100_000) {
    throw new Error("agy prompt must be NUL-free and at most 100000 bytes.");
  }
  if (process.platform === "win32") {
    throw new Error("The agy runner currently requires Linux, macOS, or WSL (process-group cancellation).");
  }

  const args = ["--output-format", "stream-json", "--disable-slash-commands", "--mode", "plan", "--print-timeout", "10m"];
  if (config.agyAgent) args.push("--agent", config.agyAgent);
  if (config.agyModel) args.push("--model", config.agyModel);
  if (config.agySkipPermissions) args.push("--dangerously-skip-permissions");
  args.push("-p", task);

  // Forward CLI authentication/runtime settings, not every secret held by Pi.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG",
    "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_GENAI_USE_VERTEXAI",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const child = spawn("agy", args, {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pending = "";
  let stderr = "";
  let responseText = "";
  let result: Record<string, unknown> | undefined;
  let failure: string | undefined;
  let aborted = false;
  let stopped = Promise.resolve();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let groupStopped = false;

  const stop = () => {
    if (groupStopped || child.pid === undefined) return;
    groupStopped = true;
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try { process.kill(-pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = `Cannot stop agy: ${String(error)}`;
      }
    };
    kill("SIGTERM");
    // Keep escalation armed even if the group leader exits before its children.
    // shortcut: independently daemonized tools escape the group; use OS isolation for containment.
    stopped = new Promise<void>((resolve) => {
      setTimeout(() => {
        kill("SIGKILL");
        // Let killed children close their pipes; bound EOF waits on escaped descendants.
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, 1000);
        resolve();
      }, 1000);
    });
  };
  const onAbort = () => { aborted = true; stop(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = setTimeout(() => { failure = "agy timed out after 10 minutes."; stop(); }, TIMEOUT_MS);

  const line = (raw: string) => {
    if (!raw.trim()) return;
    let event: unknown;
    try { event = JSON.parse(raw); }
    catch { failure = "agy emitted invalid stream-json."; stop(); return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      failure = "agy emitted an invalid event."; stop(); return;
    }
    const envelope = event as Record<string, unknown>;
    if (envelope.event === "result") {
      const value = envelope.result;
      if (!value || typeof value !== "object" || Array.isArray(value) || result) {
        failure = "agy emitted an invalid or duplicate result."; stop(); return;
      }
      result = value as Record<string, unknown>;
    } else if (envelope.event === "step_update") {
      const value = envelope.step_update;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const step = value as Record<string, unknown>;
      if (typeof step.text_delta === "string") {
        responseText = (responseText + step.text_delta).slice(-MAX_LINE_BYTES);
        options.onTextDelta?.(step.text_delta, responseText);
      }
      if (typeof step.tool_name === "string" && (step.state === "ACTIVE" || step.state === "DONE")) {
        options.onToolActivity?.({ type: step.state === "DONE" ? "end" : "start", toolName: step.tool_name });
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const raw = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(raw) > MAX_LINE_BYTES) {
        failure = "agy stream event exceeded 4 MiB."; stop(); return;
      }
      try { line(raw); }
      catch (error) { failure = `Cannot process agy progress: ${String(error)}`; stop(); }
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
      pending = "";
      failure = "agy stream event exceeded 4 MiB.";
      stop();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => { failure = `Cannot run agy: ${error.message}`; });
    child.once("close", (code) => resolve(code));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", onAbort);
  if (pending.trim()) {
    try { line(pending); }
    catch (error) { failure = `Cannot process agy progress: ${String(error)}`; stop(); }
  }
  // Wait for SIGKILL before settling: worktree cleanup must not race live tools.
  await stopped;
  clearTimeout(drainTimer);

  if (result && typeof result.response === "string") {
    responseText = result.response;
    options.onTextDelta?.("", responseText);
  }
  const usage = result?.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const values = usage as Record<string, unknown>;
    const tokens = (key: string) => typeof values[key] === "number" && Number.isSafeInteger(values[key]) && values[key] >= 0
      ? values[key] as number : 0;
    options.onAssistantUsage?.({
      input: tokens("input_tokens"),
      output: tokens("output_tokens") + tokens("thinking_tokens"),
      cacheRead: tokens("cache_read_tokens"),
      cacheWrite: 0,
    });
  }
  if (!aborted) {
    failure ??= exitCode !== 0 ? `agy exited with code ${exitCode}.`
      : !result ? "agy exited without a result."
      : result.status !== "SUCCESS" ? `agy failed (${String(result.status)}).`
      : typeof result.response !== "string" ? "agy result has no response." : undefined;
    if (failure && typeof result?.error === "string") failure += ` ${result.error}`;
    if (failure && stderr) failure += `\n${stderr}`;
  }
  return { responseText, aborted, steered: false, failure };
}
