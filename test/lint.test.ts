import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("書き方の決まり", () => {
  it.each([
    ["let", "export let count = 1;\n", "local(no-let)"],
    ["as", 'export const count = JSON.parse("1") as number;\n', "consistent-type-assertions"],
    ["<型>", 'export const count = <number>JSON.parse("1");\n', "consistent-type-assertions"],
    ["unknown", "export function f(value: unknown) {\n  return value;\n}\n", "no-restricted-types"],
    ["any", "export function f(value: any) {\n  return value;\n}\n", "no-explicit-any"],
    [
      "非 null アサーション（x!）",
      "export function f(value: string | undefined) {\n  return value!;\n}\n",
      "no-non-null-assertion",
    ],
  ])("%s を書くと Lint が失敗する", (_, source, rule) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-lint-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "sample.ts");
    writeFileSync(file, source);

    const result = spawnSync(
      join(repoRoot, "node_modules/.bin/oxlint"),
      ["-c", join(repoRoot, ".oxlintrc.json"), "--deny-warnings", file],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(rule);
  });

  it("const と as const は書ける", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "menou-lint-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "sample.ts");
    writeFileSync(file, 'export const kinds = ["a", "b"] as const;\n');

    const result = spawnSync(
      join(repoRoot, "node_modules/.bin/oxlint"),
      ["-c", join(repoRoot, ".oxlintrc.json"), "--deny-warnings", file],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });
});
