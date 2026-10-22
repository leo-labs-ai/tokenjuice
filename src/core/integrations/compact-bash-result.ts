import { getInspectionCommandSkipReason, getSafeRepositoryInventorySourceArgv } from "../inventory-safety.js";
import { readNoOmissionFromEnv } from "../env.js";
import { shouldRecordStats, storeArtifact } from "../artifacts.js";
import { reduceExecution } from "../reduce.js";
import { getCompactionSkipReason, type RewritePolicyOptions } from "./rewrite-policy.js";

import type { CompactResult, ReduceOptions, ToolExecutionInput } from "../../types.js";
import type { InspectionCommandPolicy, InspectionCommandSkipReason } from "../inventory-safety.js";

export type CompactBashResultInput = {
  source: "claude-code" | "cline" | "codex" | "command-code" | "copilot-agent" | "copilot-cli" | "droid" | "gemini-cli" | "grok-cli" | "kimi" | "mux" | "openclaw" | "openhands" | "opencode" | "pi" | "qwen-code";
  command: string;
  cwd?: string;
  visibleText: string;
  trustedFullText?: string;
  exitCode?: number;
  maxInlineChars?: number;
  noOmit?: boolean;
  allowOmit?: boolean;
  storeRaw?: boolean;
  recordStats?: boolean;
  storeDir?: string;
  metadata?: Record<string, unknown>;
  inspectionPolicy?: InspectionCommandPolicy;
  /** @deprecated use inspectionPolicy instead. */
  skipInspectionCommands?: boolean;
} & RewritePolicyOptions;

export type CompactBashResultKeepReason =
  | "empty-output"
  | InspectionCommandSkipReason
  | "unsupported"
  | "no-compaction"
  | "low-savings-compaction"
  | "generic-compound-command"
  | "generic-weak-compaction";

export type CompactBashResultOutput =
  | {
      action: "keep";
      reason: CompactBashResultKeepReason;
      rawText: string;
      usedTrustedFullText: boolean;
      result?: CompactResult;
    }
  | {
      action: "rewrite";
      rawText: string;
      usedTrustedFullText: boolean;
      result: CompactResult;
    };

function resolveInspectionPolicy(input: CompactBashResultInput): InspectionCommandPolicy {
  if (input.inspectionPolicy) {
    return input.inspectionPolicy;
  }
  return input.skipInspectionCommands ? "skip-all" : "compact-all";
}

export function getOutputAwareInspectionSkipReason(
  policy: InspectionCommandPolicy,
  executionInput: ToolExecutionInput,
): InspectionCommandSkipReason | null {
  const command = executionInput.command ?? "";
  return getInspectionCommandSkipReason(command, policy);
}

export async function compactBashResult(input: CompactBashResultInput): Promise<CompactBashResultOutput> {
  const command = input.command.trim();
  if (!command) {
    return {
      action: "keep",
      reason: "unsupported",
      rawText: "",
      usedTrustedFullText: false,
    };
  }

  const rawText = input.trustedFullText ?? input.visibleText;
  const usedTrustedFullText = typeof input.trustedFullText === "string";
  if (!rawText.trim()) {
    return {
      action: "keep",
      reason: "empty-output",
      rawText,
      usedTrustedFullText,
    };
  }

  const safeInventoryArgv = getSafeRepositoryInventorySourceArgv(command);
  const executionInput: ToolExecutionInput = {
    toolName: "exec",
    command,
    combinedText: rawText,
    ...(safeInventoryArgv ? { argv: safeInventoryArgv } : {}),
    ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd } : {}),
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  const inspectionSkipReason = getOutputAwareInspectionSkipReason(resolveInspectionPolicy(input), executionInput);
  if (inspectionSkipReason) {
    return {
      action: "keep",
      reason: inspectionSkipReason,
      rawText,
      usedTrustedFullText,
    };
  }

  const storeDir = typeof input.storeDir === "string" && input.storeDir.trim()
    ? input.storeDir.trim()
    : undefined;
  const recordStats = input.recordStats ?? shouldRecordStats();
  const options: ReduceOptions = {
    ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd } : {}),
    ...(typeof input.maxInlineChars === "number" ? { maxInlineChars: input.maxInlineChars } : {}),
    ...(input.noOmit || (!input.allowOmit && readNoOmissionFromEnv()) ? { noOmit: true } : {}),
    // store:true inside reduceExecution writes before this function can keep the output, so a
    // storeRaw caller stores below, only after the rewrite decision. A keep from a storeRaw
    // caller then leaves no raw file and no stats entry: recordStats stays off for that call
    // as well. Callers without storeRaw keep the stats policy unchanged: an explicit
    // input.recordStats wins, otherwise stats are on unless TOKENJUICE_STATS disables them.
    recordStats: input.storeRaw ? false : recordStats,
    ...(storeDir ? { storeDir } : {}),
  };

  const result = await reduceExecution(executionInput, options);
  const skipReason = getCompactionSkipReason(command, rawText, result, input);
  if (skipReason) {
    return {
      action: "keep",
      reason: skipReason,
      rawText,
      usedTrustedFullText,
      result,
    };
  }

  if (!input.storeRaw) {
    return {
      action: "rewrite",
      rawText,
      usedTrustedFullText,
      result,
    };
  }

  const rawRef = await storeArtifact(
    {
      input: executionInput,
      rawText,
      classification: result.classification,
      stats: result.stats,
      recordStats,
    },
    storeDir,
  );

  return {
    action: "rewrite",
    rawText,
    usedTrustedFullText,
    result: {
      ...result,
      rawRef,
    },
  };
}
