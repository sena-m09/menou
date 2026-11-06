import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { testWithTempDir } from "./temp-dir";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const it = testWithTempDir("menou-lint-");

function lint(dir: string, source: string) {
  const file = join(dir, "sample.ts");
  writeFileSync(file, source);
  const result = spawnSync(
    join(repoRoot, "node_modules/.bin/oxlint"),
    ["-c", join(repoRoot, ".oxlintrc.json"), "--deny-warnings", file],
    { encoding: "utf8" },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("書き方の決まり", () => {
  it.for([
    ["let", "export let count = 1;\n", "local(no-let)"],
    ["as", 'export const count = JSON.parse("1") as number;\n', "consistent-type-assertions"],
    ["<型>", 'export const count = <number>JSON.parse("1");\n', "consistent-type-assertions"],
    ["unknown", "export function f(value: unknown) {\n  return value;\n}\n", "no-restricted-types"],
    ["any", "export function f(value: any) {\n  return value;\n}\n", "no-explicit-any"],
  ] as const)("%s を書くと Lint が失敗する", ([, source, rule], { dir }) => {
    const { status, output } = lint(dir, source);

    expect(status).not.toBe(0);
    expect(output).toContain(rule);
  });

  it("const と as const は書ける", ({ dir }) => {
    const { status, output } = lint(dir, 'export const kinds = ["a", "b"] as const;\n');

    expect(status, output).toBe(0);
  });
});
