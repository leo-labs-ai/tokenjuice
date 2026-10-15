import { describe, expect, it } from "vitest";

import {
  WRAP_COMPLETE_FOOTER,
  buildWrapAuthoritativeFooter,
  countOmittedLines,
  type CompactionKind,
} from "../../src/core/compaction-metadata.js";
import { decorateWrapInlineText } from "../../src/cli/main.js";

import type { CompactResult } from "../../src/types.js";

const RAW_PATH = "/home/luke/.tokenjuice/artifacts/tj_0123456789ab.txt";

function compactedResult(kinds: CompactionKind[], inlineText: string, rawPath?: string): CompactResult {
  return {
    inlineText,
    compaction: { authoritative: true, kinds },
    stats: { rawChars: 4_000, reducedChars: inlineText.length, ratio: inlineText.length / 4_000 },
    classification: { family: "generic", confidence: 0.9, matchedReducer: "generic/fallback" },
    ...(rawPath
      ? { rawRef: { id: "tj_0123456789ab", storage: "file" as const, path: rawPath, metadataPath: `${rawPath}.json` } }
      : {}),
  };
}

function footerOf(decorated: string): string {
  return decorated.slice(decorated.lastIndexOf("\n---\n") + 5);
}

// One realistic compacted output per omitting kind, with the exact footer count expected.
const OMITTING_CASES: Array<{ kind: CompactionKind; inlineText: string; count: string }> = [
  { kind: "head-tail-omission", inlineText: "first\n... 120 lines omitted ...\nlast", count: "120 lines were omitted" },
  { kind: "middle-truncation", inlineText: "head text\n... omitted ...\ntail text", count: "content was omitted" },
  { kind: "tail-truncation", inlineText: "head text\n... truncated ...", count: "content was omitted" },
  { kind: "hashed-middle-clip", inlineText: "{\"a\":1 ...[900 chars omitted, sha256:0123456789ab]... }", count: "content was omitted" },
  {
    kind: "git-diff-hunk-clip",
    inlineText: "@@ -1,40 +1,40 @@\n+added\n... hunk clipped: 30 added, 12 removed lines omitted",
    count: "42 lines were omitted",
  },
  { kind: "inspection-package-lock-summary", inlineText: "package-lock summary: 812 packages", count: "content was omitted" },
  {
    kind: "inspection-large-document-summary",
    inlineText: "large document summary: 900 lines, 60000 chars\nexcerpt:\n... 850 lines omitted ...",
    count: "at least 850 lines were omitted",
  },
  {
    kind: "github-actions-command-list-omission",
    inlineText: "- npm ci\n... 14 commands omitted ...\n- npm test",
    count: "content was omitted",
  },
  {
    kind: "github-actions-log-signal-filter",
    inlineText: "... 1 non-signal log lines omitted ...\nError: boom",
    count: "1 line was omitted",
  },
  {
    kind: "github-status-check-rollup-omission",
    inlineText: "checks: 3 failing\n... 9 attention checks omitted ...",
    count: "content was omitted",
  },
];

describe("wrap footer accuracy", () => {
  it.each(OMITTING_CASES)("reports omission instead of completeness for $kind", ({ kind, inlineText, count }) => {
    const footer = footerOf(decorateWrapInlineText(compactedResult([kind], inlineText), false));

    expect(footer).toContain(`Output compacted: ${count}, so this is not the complete output.`);
    expect(footer).toContain("not retrievable");
    expect(footer).not.toContain("complete, authoritative");
    expect(footer).not.toBe(WRAP_COMPLETE_FOOTER);
  });

  it.each(OMITTING_CASES)("points $kind output at the saved raw file", ({ kind, inlineText, count }) => {
    const footer = footerOf(decorateWrapInlineText(compactedResult([kind], inlineText, RAW_PATH), false));

    expect(footer).toContain(`Output compacted: ${count}, so this is not the complete output.`);
    expect(footer).toContain(`The full raw output is saved at ${RAW_PATH}`);
    expect(footer).not.toContain("not retrievable");
    expect(footer).not.toContain("complete, authoritative");
  });

  it("keeps the complete wording when no kind drops content", () => {
    const decorated = decorateWrapInlineText(compactedResult([], "deduplicated output"), false);

    expect(footerOf(decorated)).toBe(WRAP_COMPLETE_FOOTER);
    expect(WRAP_COMPLETE_FOOTER).toContain("complete, authoritative");
    expect(buildWrapAuthoritativeFooter({ authoritative: true, kinds: [] }, { rawArtifactPath: RAW_PATH })).toBe(WRAP_COMPLETE_FOOTER);
  });

  it("treats unknown kinds as omitting", () => {
    const metadata = { authoritative: true, kinds: ["future-kind" as CompactionKind] };

    expect(buildWrapAuthoritativeFooter(metadata)).toContain("content was omitted");
  });

  it("sums every whole-line omission marker and ignores marker text inside content lines", () => {
    const text = [
      "... 3 lines omitted ...",
      "kept line mentioning ... 99 lines omitted ... inline",
      "... 4 non-signal log lines omitted ...",
      "... hunk clipped: 2 added, 1 removed lines omitted",
    ].join("\n");

    expect(countOmittedLines(text)).toBe(10);
  });
});
