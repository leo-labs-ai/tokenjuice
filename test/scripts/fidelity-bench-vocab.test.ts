import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../../scripts/fidelity-bench.mjs", import.meta.url));

async function bench(...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--synthetic", "--sample", "10", "--seed", "7", ...args]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("fidelity-bench --vocab", () => {
  it("keeps the default corpus unchanged and draws a different one from a larger vocabulary", async () => {
    const base = await bench();
    const explicitBase = await bench("--vocab", "10");
    const wide = await bench("--vocab", "250");

    expect(explicitBase.sampleSha).toBe(base.sampleSha);
    expect(base.vocab).toBeUndefined();
    expect(wide.vocab).toBe(250);
    expect(wide.sampleSha).not.toBe(base.sampleSha);
  }, 60_000);

  it("rejects a vocabulary smaller than two words", async () => {
    await expect(bench("--vocab", "1")).rejects.toThrow(/--vocab must be an integer >= 2/u);
  }, 60_000);
});
