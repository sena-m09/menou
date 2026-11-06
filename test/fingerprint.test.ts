import { readFileSync } from "node:fs";
import type { JsonValue } from "fast-check";
import { describe, expect, it } from "vitest";
import { type CheckDefinition, parseConfig } from "../src/config";
import { checkFieldRoles, computeFingerprints } from "../src/fingerprint";
import { type Repo, testWithRepo } from "./repo";

const files = [
  "src/a.ts",
  "src/sub/b.ts",
  "srcx/c.ts",
  "README.md",
  "docs/x.md",
  "docs/sub/y.md",
  "eslint.config.js",
];

const repoTest = testWithRepo((repo) => {
  for (const path of files) repo.write(path, path);
  repo.commitAll();
});

function check(fields: { [key: string]: JsonValue }): CheckDefinition {
  const result = parseConfig(
    JSON.stringify({
      checks: [{ id: "c", mode: "inline", run: "true", paths: ["**"], ...fields }],
    }),
  );
  if (result.status !== "loaded") throw new Error(JSON.stringify(result));
  const [loaded] = result.config.checks;
  if (loaded === undefined) throw new Error("チェックがありません");
  return loaded;
}

function fingerprintOf(repo: Repo, definition: CheckDefinition) {
  return computeFingerprints(repo.root, [definition]).fingerprints.get(definition.id);
}

function changes(repo: Repo, paths: string[], edit: () => void) {
  const definition = check({ paths });
  const before = fingerprintOf(repo, definition);
  edit();
  return fingerprintOf(repo, definition) !== before;
}

describe("04-config.md の paths の書き方", () => {
  repoTest.for<[string[], string, string]>([
    [["src"], "src/sub/b.ts", "srcx/c.ts"],
    [["src/"], "src/sub/b.ts", "srcx/c.ts"],
    [["src/*"], "src/a.ts", "src/sub/b.ts"],
    [["src/**"], "src/sub/b.ts", "srcx/c.ts"],
    [["*.md"], "README.md", "docs/x.md"],
    [["**/*.md"], "docs/sub/y.md", "eslint.config.js"],
    [["eslint.config.*"], "eslint.config.js", "src/a.ts"],
    [["**", ":(exclude)docs/**"], "src/a.ts", "docs/x.md"],
  ])(
    "%j は、%s を変えると変わり、%s を変えても変わらない",
    ([paths, inside, outside], { repo }) => {
      expect(changes(repo, paths, () => repo.write(inside, "changed"))).toBe(true);
      expect(changes(repo, paths, () => repo.write(outside, "changed"))).toBe(false);
    },
  );

  repoTest(".gitignore の対象は、paths に一致しても変えたときに変わらない", ({ repo }) => {
    repo.write(".gitignore", "*.log\n");
    repo.write("src/debug.log", "log");

    expect(changes(repo, ["src/**"], () => repo.write("src/debug.log", "changed"))).toBe(false);
  });

  repoTest(".gitignore の対象でなければ、同じファイルを変えると変わる", ({ repo }) => {
    repo.write("src/debug.log", "log");

    expect(changes(repo, ["src/**"], () => repo.write("src/debug.log", "changed"))).toBe(true);
  });

  repoTest("どのファイルにも一致しない paths でも、エラーにならずに計算できる", ({ repo }) => {
    expect(fingerprintOf(repo, check({ paths: ["nothing/**"] }))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("paths の範囲のファイル", () => {
  repoTest("コミットしていない変更で変わる", ({ repo }) => {
    expect(changes(repo, ["src/**"], () => repo.write("src/a.ts", "changed"))).toBe(true);
  });

  repoTest("まだ追跡していないファイルを足すと変わる", ({ repo }) => {
    expect(changes(repo, ["src/**"], () => repo.write("src/new.ts", "new"))).toBe(true);
  });

  repoTest("消すと変わる", ({ repo }) => {
    expect(changes(repo, ["src/**"], () => repo.remove("src/a.ts"))).toBe(true);
  });

  repoTest("実行権限を変えると変わる", ({ repo }) => {
    expect(changes(repo, ["src/**"], () => repo.setExecutable("src/a.ts", true))).toBe(true);
  });

  repoTest("git add しただけでは変わらない", ({ repo }) => {
    repo.write("src/a.ts", "changed");

    expect(changes(repo, ["src/**"], () => repo.git("add", "-A"))).toBe(false);
  });

  repoTest("同じ内容なら、何度計算しても同じ値になる", ({ repo }) => {
    const definition = check({ paths: ["src/**"] });
    repo.write("src/new.ts", "new");

    expect(fingerprintOf(repo, definition)).toBe(fingerprintOf(repo, definition));
  });

  repoTest("中身を変えて元に戻すと、元の値に戻る", ({ repo }) => {
    const definition = check({ paths: ["src/**"] });
    const before = fingerprintOf(repo, definition);
    repo.write("src/a.ts", "changed");
    repo.write("src/a.ts", "src/a.ts");

    expect(fingerprintOf(repo, definition)).toBe(before);
  });
});

describe("チェック定義", () => {
  repoTest.for<[string, { [key: string]: JsonValue }, { [key: string]: JsonValue }]>([
    ["run", { run: "pnpm lint" }, { run: "pnpm test" }],
    ["paths", { paths: ["src/**"] }, { paths: ["src/**", "test/**"] }],
    ["paths の並び", { paths: ["src/**", "test/**"] }, { paths: ["test/**", "src/**"] }],
    ["timeout", { timeout: 60 }, { timeout: 61 }],
  ])("%s を変えると変わる", ([, before, after], { repo }) => {
    expect(fingerprintOf(repo, check(after))).not.toBe(fingerprintOf(repo, check(before)));
  });

  repoTest("timeout を省くと、既定値の 120 を書いたときと同じ値になる", ({ repo }) => {
    expect(fingerprintOf(repo, check({}))).toBe(fingerprintOf(repo, check({ timeout: 120 })));
  });

  repoTest("id が違っても、run・paths・timeout が同じなら同じ値になる", ({ repo }) => {
    const { fingerprints } = computeFingerprints(repo.root, [
      check({ id: "first" }),
      check({ id: "second", mode: "evidence", severity: "warn", hint: "h" }),
    ]);

    expect(fingerprints.get("first")).toBe(fingerprints.get("second"));
  });

  repoTest("複数のチェックを渡すと、作業ツリー全体の tree と、id ごとの値を返す", ({ repo }) => {
    const result = computeFingerprints(repo.root, [
      check({ id: "src", paths: ["src/**"] }),
      check({ id: "docs", paths: ["docs/**"] }),
    ]);
    repo.commitAll();

    expect(result.tree).toBe(repo.git("rev-parse", "HEAD^{tree}").trim());
    expect([...result.fingerprints.keys()]).toEqual(["src", "docs"]);
    expect(result.fingerprints.get("src")).not.toBe(result.fingerprints.get("docs"));
  });
});

describe("フィンガープリントに含めるかどうかの分類", () => {
  it("schema.json のチェック定義のフィールドは、すべて含めるか含めないかに分類してある", () => {
    const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
    const fields = Object.keys(schema.properties.checks.items.properties);

    expect(Object.keys(checkFieldRoles).sort()).toEqual(fields.sort());
  });

  it("含めるのは run・paths・timeout だけ", () => {
    const included = Object.entries(checkFieldRoles)
      .filter(([, role]) => role === "included")
      .map(([field]) => field);

    expect(included.sort()).toEqual(["paths", "run", "timeout"]);
  });
});
