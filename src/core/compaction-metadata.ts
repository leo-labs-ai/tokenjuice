export type CompactionKind =
  | "head-tail-omission"
  | "middle-truncation"
  | "tail-truncation"
  | "hashed-middle-clip"
  | "git-diff-hunk-clip"
  | "inspection-package-lock-summary"
  | "github-actions-command-list-omission"
  | "github-actions-log-signal-filter"
  | "github-status-check-rollup-omission";

export type CompactionMetadata = {
  authoritative: boolean;
  kinds: CompactionKind[];
};

export const NO_COMPACTION_METADATA: CompactionMetadata = {
  authoritative: false,
  kinds: [],
};

/**
 * What each compaction kind does to the output. "omits" kinds drop lines or
 * characters (the inline text carries an omission marker); "noise-only" kinds
 * remove low-signal noise without dropping content. The record is exhaustive
 * so every new kind has to be classified before it can ship.
 */
const COMPACTION_KIND_EFFECT: Record<CompactionKind, "omits" | "noise-only"> = {
  "head-tail-omission": "omits",
  "middle-truncation": "omits",
  "tail-truncation": "omits",
  "hashed-middle-clip": "omits",
  "git-diff-hunk-clip": "omits",
  "inspection-package-lock-summary": "omits",
  "github-actions-command-list-omission": "omits",
  "github-actions-log-signal-filter": "omits",
  "github-status-check-rollup-omission": "omits",
};

// Omitting kinds whose markers count every line they drop.
const LINE_COUNTED_KINDS: ReadonlySet<string> = new Set<CompactionKind>([
  "head-tail-omission",
  "git-diff-hunk-clip",
  "github-actions-log-signal-filter",
]);

const OMITTED_LINES_MARKER_PATTERN = /^\.\.\. (\d+) (?:[\w-]+ )*lines omitted \.\.\.$/u;
const HUNK_CLIPPED_MARKER_PATTERN = /^\.\.\. hunk clipped: (\d+) added, (\d+) removed lines omitted$/u;

/** True when any kind drops content. Unknown kinds count as omitting. */
export function compactionOmitsContent(metadata: CompactionMetadata | undefined): boolean {
  return (metadata?.kinds ?? []).some((kind) => COMPACTION_KIND_EFFECT[kind] !== "noise-only");
}

/** Sums the line counts carried by omission markers in compacted output. */
export function countOmittedLines(inlineText: string): number {
  let total = 0;
  for (const line of inlineText.split("\n")) {
    const lines = line.match(OMITTED_LINES_MARKER_PATTERN);
    if (lines) {
      total += Number(lines[1]);
      continue;
    }
    const hunk = line.match(HUNK_CLIPPED_MARKER_PATTERN);
    if (hunk) {
      total += Number(hunk[1]) + Number(hunk[2]);
    }
  }
  return total;
}

const DO_NOT_RECOVER = "Do not re-run the command, vary flags, switch tools, or redirect output to a temp file to recover it.";

/** Footer for compaction that only removed noise: the output is complete. */
export const WRAP_COMPLETE_FOOTER = "[tokenjuice] This is the complete, authoritative output for this command. It was deterministically compacted to remove low-signal noise only; no content was dropped. Do not re-run the command, vary flags, or switch tools to try to recover it. Proceed with the task using this output.";

function describeOmission(omittedLines: number, exact: boolean): string {
  if (omittedLines <= 0) {
    return "content was omitted";
  }
  const count = `${exact ? "" : "at least "}${omittedLines} ${omittedLines === 1 ? "line was" : "lines were"}`;
  return `${count} omitted`;
}

function buildOmittedFooter(omission: string, rawArtifactPath?: string, rerunSafe = false): string {
  const lead = `[tokenjuice] Output compacted: ${omission}, so this is not the complete output.`;
  if (rawArtifactPath) {
    return `${lead} The full raw output is saved at ${rawArtifactPath} — read that file directly if you need any omitted detail. ${DO_NOT_RECOVER}`;
  }
  if (rerunSafe) {
    // Read-only commands (listings, searches, git diff/show, cat-like reads) can be re-run without side effects.
    return `${lead} The omitted content was not saved and is not retrievable from tokenjuice. Proceed with this output if it is enough; only if you need the omitted detail, re-run once with \`tokenjuice wrap --raw -- <command>\`.`;
  }
  // Re-running anything else could repeat side effects, so do not suggest it.
  return `${lead} The omitted content was not saved and is not retrievable. Proceed with this output. ${DO_NOT_RECOVER}`;
}

/** Footer for omitting compaction when no line count is known, no raw output was saved and the command is not known to be read-only. */
export const WRAP_AUTHORITATIVE_FOOTER = buildOmittedFooter(describeOmission(0, false));

export type WrapFooterOptions = {
  /** Compacted inline text, scanned for omission markers to report a line count. */
  inlineText?: string;
  /** Path of the saved raw output artifact, when one exists. */
  rawArtifactPath?: string;
  /**
   * True only when the command is read-only (see `isReadOnlyRerunCommand`).
   * Only then may the footer suggest a `--raw` re-run.
   */
  rerunSafe?: boolean;
};

/**
 * Footer appended to compacted wrap output. Omitting kinds say that content
 * was dropped (with the line count when the markers carry it) and point at the
 * saved raw output when there is one. Without saved output, only read-only
 * commands (`rerunSafe`) get the `--raw` re-run hint; everything else is told
 * the omitted content is not retrievable. Only noise-only compaction claims
 * the output is complete.
 */
export function buildWrapAuthoritativeFooter(metadata: CompactionMetadata | undefined, options: WrapFooterOptions = {}): string {
  if (!compactionOmitsContent(metadata)) {
    return WRAP_COMPLETE_FOOTER;
  }
  const kinds = metadata?.kinds ?? [];
  const omittedLines = countOmittedLines(options.inlineText ?? "");
  const exact = kinds.every((kind) => LINE_COUNTED_KINDS.has(kind));
  return buildOmittedFooter(describeOmission(omittedLines, exact), options.rawArtifactPath, options.rerunSafe === true);
}

export function createCompactionMetadata(...kinds: CompactionKind[]): CompactionMetadata {
  if (kinds.length === 0) {
    return NO_COMPACTION_METADATA;
  }

  return {
    authoritative: true,
    kinds: Array.from(new Set(kinds)),
  };
}

export function mergeCompactionMetadata(...values: Array<CompactionMetadata | undefined>): CompactionMetadata {
  const kinds = values.flatMap((value) => value?.kinds ?? []);
  return createCompactionMetadata(...kinds);
}
