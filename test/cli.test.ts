import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { run } from "../src/cli";

function runCli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = run(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("menou コマンド", () => {
  it("--version でパッケージの version を表示する", () => {
    expect(runCli(["--version"])).toEqual({
      code: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
  });

  it("知らないサブコマンドは失敗で終わり、フックのブロック（終了コード 2）とは区別できる", () => {
    const { code, stderr } = runCli(["unknown"]);
    expect(code).not.toBe(0);
    expect(code).not.toBe(2);
    expect(stderr).toContain("unknown");
  });
});
