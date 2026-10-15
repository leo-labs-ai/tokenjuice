import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../../scripts/fidelity-bench.mjs", import.meta.url));

const ESC = "\u001B";
const outputs: Record<string, string> = {
  "colour-diff.txt": [
    `${ESC}[1mdiff --git a/src/a.ts b/src/a.ts${ESC}[m`,
    `${ESC}[1mindex 1234567..89abcde 100644${ESC}[m`,
    `${ESC}[1m--- a/src/a.ts${ESC}[m`,
    `${ESC}[1m+++ b/src/a.ts${ESC}[m`,
    `${ESC}[36m@@ -1,3 +1,3 @@${ESC}[m`,
    ` const x = 1;`,
    `${ESC}[31m-const a = 1;${ESC}[m`,
    `${ESC}[32m+const a = 2;${ESC}[m`,
  ].join("\n"),
  "unified-diff.txt": ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " const x = 1;", "-const a = 1;", "+const a = 2;"].join("\n"),
  "search.txt": ["src/a.ts:12:  foo()", "src/b.ts:3:  bar()", "src/c.ts:40:  baz()"].join("\n"),
  "files.txt": ["src/a.ts", "src/b/c.ts", "test/d.test.ts"].join("\n"),
  "read-code.txt": ["const a = 1;", "--- not a header", "+++ still not", "@@ -1 is text"].join("\n"),
  "notes.txt": ["-- a SQL comment", "--- divider", "plain text"].join("\n"),
};

describe("fidelity-bench", () => {
  it("labels coloured and bare unified diffs as the diff family", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenjuice-fidelity-"));
    try {
      for (const [name, text] of Object.entries(outputs)) await writeFile(join(dir, name), text);
      const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--dir", dir, "--sample", "10", "--by-family"]);
      const families = Object.fromEntries(
        Object.entries(JSON.parse(stdout).byFamily as Record<string, { files: number }>).map(([family, stats]) => [family, stats.files]),
      );
      expect(families).toEqual({ diff: 2, grep: 1, listing: 1, read: 1, generic: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
