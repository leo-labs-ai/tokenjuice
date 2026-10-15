import { describe, expect, it } from "vitest";

import { isReadOnlyRerunCommand } from "../../src/core/rerun-safety.js";

describe("isReadOnlyRerunCommand", () => {
  it.each([
    [["cat", "big.log"]],
    [["head", "-n", "50", "big.log"]],
    [["sed", "-n", "1,200p", "src/main.ts"]],
    [["jq", ".items", "data.json"]],
    [["ls", "-la"]],
    [["tree", "src"]],
    [["find", ".", "-name", "*.ts"]],
    [["fd", "-e", "ts"]],
    [["rg", "-n", "TODO", "src"]],
    [["grep", "-rn", "TODO", "src"]],
    [["git", "diff", "HEAD~1"]],
    [["git", "-C", "repo", "show", "HEAD"]],
    [["git", "ls-files"]],
    [["git", "grep", "needle"]],
    [["LC_ALL=C", "rg", "needle"]],
    [["bash", "-lc", "git show HEAD --stat"]],
    [["sh", "-c", "cd repo && rg needle"]],
  ])("allows a raw re-run for read-only %j", (argv) => {
    expect(isReadOnlyRerunCommand(argv)).toBe(true);
  });

  it.each([
    [["pnpm", "test"]],
    [["npm", "install"]],
    [["make", "deploy"]],
    [["python", "script.py"]],
    [["git", "push"]],
    [["git", "commit", "-m", "x"]],
    [["git", "diff", "--output=changes.patch"]],
    [["git", "-c", "diff.external=./tool", "diff"]],
    [["git", "diff", "--ext-diff"]],
    [["sed", "-i", "s/a/b/", "file.txt"]],
    [["sed", "-n", "w out.txt", "file.txt"]],
    [["sed", "-f", "script.sed", "file.txt"]],
    [["yq", "-i", ".a = 1", "file.yaml"]],
    [["find", ".", "-name", "*.tmp", "-delete"]],
    [["find", ".", "-exec", "rm", "{}", ";"]],
    [["fd", "-x", "rm"]],
    [["rg", "--pre", "./decode", "needle"]],
    [["bash", "-lc", "git diff > out.patch"]],
    [["bash", "-lc", "cat file | tee copy"]],
    [["bash", "-lc", "cat $(make-list)"]],
    [["bash", "-lc", "rg needle; rm -rf build"]],
    [["bash", "script.sh"]],
    [[]],
  ])("refuses a raw re-run for %j", (argv) => {
    expect(isReadOnlyRerunCommand(argv)).toBe(false);
  });
});
