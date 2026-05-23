export {
  buildBypassNotice,
  buildCompactionNotice,
  buildTokenjuiceDetails,
  extractTextContent,
  mergeDetails,
  type TokenjuiceDetails,
} from "../../shared/tool-result.js";
import { isRecord } from "./pi-types.js";

export function parseExitCode(text: string, isError: boolean): number {
  if (!isError) {
    return 0;
  }
  const match = text.match(/Command exited with code (\d+)/u);
  if (match?.[1]) {
    return Number(match[1]);
  }
  return 1;
}

export function extractFullOutputPath(details: unknown): string | undefined {
  if (isRecord(details) && typeof details.fullOutputPath === "string" && details.fullOutputPath) {
    return details.fullOutputPath;
  }

  return undefined;
}

export function stripPiBashEpilogue(text: string): string {
  return text
    .replace(/\n\nCommand exited with code \d+\s*$/u, "")
    .replace(/\n\nCommand timed out after \d+ seconds\s*$/u, "")
    .replace(/\n\nCommand aborted\s*$/u, "");
}

/**
 * Parsed shape of a `bash_output` tool result. The pi `bash_output` tool always
 * returns `"<header>\n\n<body>"`, where the header carries job status and the
 * body is the actual captured shell output we want to compact.
 */
export type BashOutputParts = {
  header: string;
  body: string;
  exitCode: number;
};

const BASH_OUTPUT_BODY_PLACEHOLDERS = new Set(["(no output yet)", ""]);

function parseExitCodeFromBashOutputHeader(header: string): number {
  const exitedMatch = header.match(/\bstatus:\s*exited\s*\(exit\s+(-?\d+)\)/u);
  if (exitedMatch?.[1]) {
    return Number(exitedMatch[1]);
  }
  if (/\bstatus:\s*(killed|failed)\b/u.test(header)) {
    return 1;
  }
  return 0;
}

/**
 * Split a `bash_output` tool result into header + body. Returns `undefined`
 * when the text does not match the expected shape (defensive: never compact
 * something we cannot rebuild safely).
 */
export function parseBashOutputParts(text: string): BashOutputParts | undefined {
  const split = text.indexOf("\n\n");
  if (split === -1) {
    return undefined;
  }
  const header = text.slice(0, split);
  const body = text.slice(split + 2);
  if (!/^bgId:\s/u.test(header)) {
    return undefined;
  }
  if (BASH_OUTPUT_BODY_PLACEHOLDERS.has(body.trim())) {
    return undefined;
  }
  return {
    header,
    body,
    exitCode: parseExitCodeFromBashOutputHeader(header),
  };
}

/**
 * Extract the original backgrounded command from a `bash_output` tool result's
 * `details` payload. Pi spreads the full job record into details, so the
 * command lives at `details.command`. Returns `undefined` when missing so the
 * caller can bail out rather than feeding command-blind heuristics.
 */
export function extractBashOutputCommand(details: unknown): string | undefined {
  if (isRecord(details) && typeof details.command === "string" && details.command.trim()) {
    return details.command;
  }
  return undefined;
}
