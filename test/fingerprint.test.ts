import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CheckDefinition, parseConfig } from "../src/config";
import { checkFieldRoles, computeFingerprints } from "../src/fingerprint";
import { createRepo, type Repo } from "./repo";

let repo: Repo;

const files = [
  "src/a.ts",
  "src/sub/b.ts",
  "srcx/c.ts",
  "README.md",
  "docs/x.md",
  "docs/sub/y.md",
  "eslint.config.js",
];

beforeEach(() => {
  repo = createRepo();
  for (const path of files) repo.write(path, path);
  repo.commitAll();
});

afterEach(() => {
  repo.cleanup();
});

function check(fields: Record<string, unknown>): CheckDefinition {
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

function fingerprintOf(definition: CheckDefinition) {
  return computeFingerprints(repo.root, [definition]).fingerprints.get(definition.id);
}

function changes(paths: string[], edit: () => void) {
  const definition = check({ paths });
  const before = fingerprintOf(definition);
  edit();
  return fingerprintOf(definition) !== before;
}

describe("04-config.md の paths の書き方", () => {
  it.each([
    [["src"], "src/sub/b.ts", "srcx/c.ts"],
    [["src/"], "src/sub/b.ts", "srcx/c.ts"],
    [["src/*"], "src/a.ts", "src/sub/b.ts"],
    [["src/**"], "src/sub/b.ts", "srcx/c.ts"],
    [["*.md"], "README.md", "docs/x.md"],
    [["**/*.md"], "docs/sub/y.md", "eslint.config.js"],
    [["eslint.config.*"], "eslint.config.js", "src/a.ts"],
    [["**", ":(exclude)docs/**"], "src/a.ts", "docs/x.md"],
  ])("%j は、%s を変えると変わり、%s を変えても変わらない", (paths, inside, outside) => {
    expect(changes(paths, () => repo.write(inside, "changed"))).toBe(true);
    expect(changes(paths, () => repo.write(outside, "changed"))).toBe(false);
  });

  it(".gitignore の対象は、paths に一致しても変えたときに変わらない", () => {
    repo.write(".gitignore", "*.log\n");
    repo.write("src/debug.log", "log");

    expect(changes(["src/**"], () => repo.write("src/debug.log", "changed"))).toBe(false);
  });

  it(".gitignore の対象でなければ、同じファイルを変えると変わる", () => {
    repo.write("src/debug.log", "log");

    expect(changes(["src/**"], () => repo.write("src/debug.log", "changed"))).toBe(true);
  });

  it("どのファイルにも一致しない paths でも、エラーにならずに計算できる", () => {
    expect(fingerprintOf(check({ paths: ["nothing/**"] }))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("paths の範囲のファイル", () => {
  it("コミットしていない変更で変わる", () => {
    expect(changes(["src/**"], () => repo.write("src/a.ts", "changed"))).toBe(true);
  });

  it("まだ追跡していないファイルを足すと変わる", () => {
    expect(changes(["src/**"], () => repo.write("src/new.ts", "new"))).toBe(true);
  });

  it("消すと変わる", () => {
    expect(changes(["src/**"], () => repo.remove("src/a.ts"))).toBe(true);
  });

  it("実行権限を変えると変わる", () => {
    expect(changes(["src/**"], () => repo.setExecutable("src/a.ts", true))).toBe(true);
  });

  it("git add しただけでは変わらない", () => {
    repo.write("src/a.ts", "changed");

    expect(changes(["src/**"], () => repo.git("add", "-A"))).toBe(false);
  });

  it("同じ内容なら、何度計算しても同じ値になる", () => {
    const definition = check({ paths: ["src/**"] });
    repo.write("src/new.ts", "new");

    expect(fingerprintOf(definition)).toBe(fingerprintOf(definition));
  });

  it("中身を変えて元に戻すと、元の値に戻る", () => {
    const definition = check({ paths: ["src/**"] });
    const before = fingerprintOf(definition);
    repo.write("src/a.ts", "changed");
    repo.write("src/a.ts", "src/a.ts");

    expect(fingerprintOf(definition)).toBe(before);
  });
});

describe("チェック定義", () => {
  it.each([
    ["run", { run: "pnpm lint" }, { run: "pnpm test" }],
    ["paths", { paths: ["src/**"] }, { paths: ["src/**", "test/**"] }],
    ["paths の並び", { paths: ["src/**", "test/**"] }, { paths: ["test/**", "src/**"] }],
    ["timeout", { timeout: 60 }, { timeout: 61 }],
  ])("%s を変えると変わる", (_, before, after) => {
    expect(fingerprintOf(check(after))).not.toBe(fingerprintOf(check(before)));
  });

  it("timeout を省くと、既定値の 120 を書いたときと同じ値になる", () => {
    expect(fingerprintOf(check({}))).toBe(fingerprintOf(check({ timeout: 120 })));
  });

  it("id が違っても、run・paths・timeout が同じなら同じ値になる", () => {
    const { fingerprints } = computeFingerprints(repo.root, [
      check({ id: "first" }),
      check({ id: "second", mode: "evidence", severity: "warn", hint: "h" }),
    ]);

    expect(fingerprints.get("first")).toBe(fingerprints.get("second"));
  });

  it("複数のチェックを渡すと、作業ツリー全体の tree と、id ごとの値を返す", () => {
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
