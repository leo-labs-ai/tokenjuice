import { readFile, stat } from "node:fs/promises";

import { compactBashResult, getOutputAwareInspectionSkipReason } from "../../../core/integrations/compact-bash-result.js";

import type { Pi, PiContext, PiToolResultEvent } from "./pi-types.js";
import { isRecord } from "./pi-types.js";
import { getAutoCompactionEnabled } from "./settings.js";
import { buildTokenjuiceStatusMessage, buildTokenjuiceStatusSnapshot } from "./status.js";
import { showTokenjuiceStatusPanel } from "./status-panel.js";
import {
  buildBypassNotice,
  buildCompactionNotice,
  buildTokenjuiceDetails,
  extractBashOutputCommand,
  extractFullOutputPath,
  extractTextContent,
  mergeDetails,
  parseBashOutputParts,
  parseExitCode,
  stripPiBashEpilogue,
} from "./tool-result.js";
import { formatErrorMessage } from "./utils.js";

export type PiExtensionRuntimeConfig = {
  extensionCommand: string;
};

const DEFAULT_MAX_INLINE_CHARS = 1200;
const GENERIC_FALLBACK_MIN_SAVED_CHARS = 120;
const GENERIC_FALLBACK_MAX_RATIO = 0.75;
const MAX_TRUSTED_FULL_OUTPUT_BYTES = 8 * 1024 * 1024;

export function createTokenjuicePiExtension(config: PiExtensionRuntimeConfig) {
  const extensionCommand = config.extensionCommand || "tj";

  return function tokenjuicePiExtension(pi: Pi): void {
    let enabled = true;
    let bypassNext = false;
    let autoCompactEnabled = true;

    function getProjectRoot(ctx: PiContext): string {
      return ctx.sessionManager.getHeader?.()?.cwd || ctx.sessionManager.getCwd?.() || ctx.cwd;
    }

    async function loadFullOutputText(fullOutputPath: string): Promise<string | null> {
      let details;
      try {
        details = await stat(fullOutputPath);
      } catch (error) {
        throw new Error(`tokenjuice failed to stat bash full output file ${fullOutputPath}: ${formatErrorMessage(error)}`);
      }

      if (details.size > MAX_TRUSTED_FULL_OUTPUT_BYTES) {
        return null;
      }

      try {
        return await readFile(fullOutputPath, "utf8");
      } catch (error) {
        throw new Error(`tokenjuice failed to read bash full output file ${fullOutputPath}: ${formatErrorMessage(error)}`);
      }
    }

    function refreshState(ctx: PiContext): void {
      enabled = true;
      const sessionEntries = typeof ctx.sessionManager.getEntries === "function"
        ? ctx.sessionManager.getEntries()
        : ctx.sessionManager.getBranch();
      for (const entry of sessionEntries) {
        if (entry.type === "custom" && entry.customType === "tokenjuice-pi-config") {
          if (isRecord(entry.data) && typeof entry.data.enabled === "boolean") {
            enabled = entry.data.enabled;
          }
        }
      }
      autoCompactEnabled = getAutoCompactionEnabled(getProjectRoot(ctx));
    }

    function persistState(): void {
      pi.appendEntry("tokenjuice-pi-config", { enabled });
    }

    pi.on("session_start", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.registerCommand(extensionCommand, {
      description: "Control tokenjuice bash output compaction",
      handler: async (args, ctx) => {
        refreshState(ctx);

        const action = (args || "status").trim().toLowerCase();
        if (action === "status" || action === "") {
          if (ctx.hasUI && typeof ctx.ui.custom === "function") {
            await showTokenjuiceStatusPanel(
              ctx,
              buildTokenjuiceStatusSnapshot(ctx.sessionManager, {
                manualEnabled: enabled,
                autoCompactEnabled,
                bypassNext,
              }),
            );
          } else {
            ctx.ui.notify(buildTokenjuiceStatusMessage(enabled, autoCompactEnabled, bypassNext), "info");
          }
          return;
        }

        if (action === "on") {
          enabled = true;
          persistState();
          if (autoCompactEnabled) {
            ctx.ui.notify("tokenjuice compaction enabled", "info");
          } else {
            ctx.ui.notify("tokenjuice compaction enabled, but pi auto-compaction is disabled by settings", "warning");
          }
          return;
        }

        if (action === "off") {
          enabled = false;
          persistState();
          ctx.ui.notify("tokenjuice compaction disabled", "info");
          return;
        }

        if (action === "raw-next" || action === "bypass-next") {
          bypassNext = true;
          ctx.ui.notify("tokenjuice will bypass the next bash result", "info");
          return;
        }

        ctx.ui.notify(`usage: /${extensionCommand} [status|on|off|raw-next]`, "warning");
      },
    });

    /**
     * Compact a single bash-style payload. Returns the rebuilt visible text
     * plus tokenjuice details when compaction fired, `undefined` when the
     * heuristics chose to keep the original output, or a `{ bypass: true }`
     * marker when the user asked for raw-next.
     */
    async function runBashCompaction(args: {
      command: string;
      visibleText: string;
      exitCode: number;
      fullOutputPath: string | undefined;
      bypass: boolean;
      sourceLabel: string;
      cwd: string;
    }): Promise<
      | { kind: "bypass"; text: string }
      | { kind: "compacted"; text: string; notice: string; details: ReturnType<typeof buildTokenjuiceDetails> }
      | undefined
    > {
      const { command, visibleText, exitCode, fullOutputPath, bypass, sourceLabel, cwd } = args;

      if (bypass) {
        const bypassText = fullOutputPath ? await loadFullOutputText(fullOutputPath) : null;
        return { kind: "bypass", text: bypassText ?? visibleText };
      }

      const visibleExecutionInput = {
        toolName: "exec",
        command,
        combinedText: visibleText,
        exitCode,
      };
      if (getOutputAwareInspectionSkipReason("allow-safe-inventory", visibleExecutionInput)) {
        return undefined;
      }

      const trustedFullOutputText = fullOutputPath ? await loadFullOutputText(fullOutputPath) : undefined;
      if (fullOutputPath && trustedFullOutputText === null) {
        return undefined;
      }

      let outcome;
      try {
        outcome = await compactBashResult({
          source: "pi",
          command,
          cwd,
          visibleText,
          ...(typeof trustedFullOutputText === "string" ? { trustedFullText: trustedFullOutputText } : {}),
          exitCode,
          maxInlineChars: DEFAULT_MAX_INLINE_CHARS,
          inspectionPolicy: "allow-safe-inventory",
          minSavedCharsAny: 8,
          genericFallbackMinSavedChars: GENERIC_FALLBACK_MIN_SAVED_CHARS,
          genericFallbackMaxRatio: GENERIC_FALLBACK_MAX_RATIO,
          skipGenericFallbackForCompoundCommands: false,
          metadata: { source: sourceLabel },
        });
      } catch (error) {
        throw new Error(`tokenjuice failed to compact bash output: ${formatErrorMessage(error)}`);
      }

      if (outcome.action === "keep") {
        return undefined;
      }

      return {
        kind: "compacted",
        text: outcome.result.inlineText,
        notice: buildCompactionNotice(outcome.result, fullOutputPath),
        details: buildTokenjuiceDetails(outcome.result),
      };
    }

    pi.on("tool_result", async (rawEvent, ctx) => {
      const event = rawEvent as PiToolResultEvent;
      // Match all four bash-tool surfaces pi exposes: the lowercase legacy
      // `bash` + `bash_output` variants and the Claude-Code-style uppercase
      // `Bash` + `BashOutput` variants. Tokenjuice treats them identically;
      // the only branching is foreground (input.command) vs. backgrounded
      // log read (header + body).
      const toolName = event.toolName;
      const isForeground = toolName === "bash" || toolName === "Bash";
      const isBashOutput = toolName === "bash_output" || toolName === "BashOutput";
      if (!isForeground && !isBashOutput) {
        return undefined;
      }

      // Skip compaction inside sub-agent sessions (ctx.source === "child-agent").
      // Read-only explore agents return curated findings to the parent;
      // compacting their internal bash output corrupts the signal they exist to
      // produce, and the parent already receives a compact report. Mirrors how
      // pi-memory gates heavy work on `ctx.source === "child-agent"`.
      if ((ctx as { source?: string } | null | undefined)?.source === "child-agent") {
        return undefined;
      }

      refreshState(ctx);

      const shouldBypass = bypassNext;
      if (shouldBypass) {
        bypassNext = false;
      }

      if (!enabled || !autoCompactEnabled) {
        return undefined;
      }

      const outputText = extractTextContent(event.content);
      if (!outputText.trim()) {
        return undefined;
      }

      const fullOutputPath = extractFullOutputPath(event.details);

      if (isForeground) {
        const command = isRecord(event.input) && typeof event.input.command === "string"
          ? event.input.command
          : "";
        if (!command) {
          return undefined;
        }

        const exitCode = parseExitCode(outputText, Boolean(event.isError));
        const visibleText = stripPiBashEpilogue(outputText);

        const outcome = await runBashCompaction({
          command,
          visibleText,
          exitCode,
          fullOutputPath,
          bypass: shouldBypass,
          sourceLabel: "pi-tool-result",
          cwd: ctx.cwd,
        });
        if (!outcome) {
          return undefined;
        }
        if (outcome.kind === "bypass") {
          return {
            content: [{ type: "text", text: `${outcome.text}\n\n[${buildBypassNotice(fullOutputPath)}]` }],
          };
        }
        return {
          content: [{ type: "text", text: `${outcome.text}\n\n[${outcome.notice}]` }],
          details: mergeDetails(event.details, outcome.details),
        };
      }

      // bash_output / BashOutput: the visible payload is `<header>\n\n<body>`
      // where header carries job status and body is the captured shell output.
      // Only the body benefits from compaction; the header must be preserved
      // verbatim so the agent still sees bgId/status/exit/elapsed.
      const parts = parseBashOutputParts(outputText);
      if (!parts) {
        return undefined;
      }

      // Bail out when we don't know the original command. Heuristics in
      // compactBashResult key off the command string (e.g. "git status" picks
      // the git-status reducer), and a synthetic placeholder would just route
      // everything through the weak generic fallback for no real win.
      const command = extractBashOutputCommand(event.details);
      if (!command) {
        return undefined;
      }

      const outcome = await runBashCompaction({
        command,
        visibleText: parts.body,
        exitCode: parts.exitCode,
        fullOutputPath,
        bypass: shouldBypass,
        sourceLabel: "pi-bash-output",
        cwd: ctx.cwd,
      });
      if (!outcome) {
        return undefined;
      }
      if (outcome.kind === "bypass") {
        return {
          content: [{
            type: "text",
            text: `${parts.header}\n\n${outcome.text}\n\n[${buildBypassNotice(fullOutputPath)}]`,
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: `${parts.header}\n\n${outcome.text}\n\n[${outcome.notice}]`,
        }],
        details: mergeDetails(event.details, outcome.details),
      };
    });
  };
}
