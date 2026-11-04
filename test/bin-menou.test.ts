import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/menou");

let pathDir: string;

beforeEach(() => {
  pathDir = mkdtempSync(join(tmpdir(), "menou-bin-"));
});

afterEach(() => {
  rmSync(pathDir, { recursive: true, force: true });
});

function runWrapper(args: string[]) {
  return spawnSync(wrapper, args, {
    env: { PATH: pathDir },
    encoding: "utf8",
  });
}

describe("bin/menou", () => {
  it("node があれば、まとめた JS に引数をそのまま渡して実行する", () => {
    const fakeNode = join(pathDir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fakeNode, 0o755);

    const result = runWrapper(["run", "lint"]);

    expect(result.status).toBe(0);
    const [script, ...args] = result.stdout.trimEnd().split("\n");
    expect(resolve(script ?? "")).toBe(join(repoRoot, "dist/menou.cjs"));
    expect(args).toEqual(["run", "lint"]);
  });

  it("node が PATH になければ、そのことを知らせて終了コード 127 で止まる", () => {
    const result = runWrapper(["run", "lint"]);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("node が見つかりません");
  });
});
