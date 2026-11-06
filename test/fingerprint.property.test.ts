import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CheckDefinition, parseConfig } from "../src/config";
import { computeFingerprints, fingerprint, fingerprintSource } from "../src/fingerprint";
import { createRepo } from "./repo";

const nearbyStringArb = fc.oneof(
  fc.constantFrom("", "a", "b", "a b", '"', "\\", "\0"),
  fc.string(),
);

const lsFilesArb = fc.oneof(
  fc.constantFrom("", "100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tsrc/a.ts\0"),
  fc
    .array(
      fc.record({
        mode: fc.constantFrom("100644", "100755", "120000"),
        hash: fc.constantFrom(
          "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
          "78981922613b2afb6025042ff6bd878ac1994e85",
        ),
        path: fc.constantFrom("src/a.ts", "src/b.ts", "a.ts"),
      }),
      { maxLength: 3 },
    )
    .map((entries) => entries.map((e) => `${e.mode} ${e.hash} 0\t${e.path}\0`).join("")),
  fc.string(),
);

const includedArb = fc.record({
  run: nearbyStringArb.filter((run) => run.length > 0),
  paths: fc.array(
    nearbyStringArb.filter((path) => path.length > 0),
    { minLength: 1, maxLength: 3 },
  ),
  timeout: fc.oneof(fc.constantFrom(1, 120), fc.integer({ min: 1, max: 100_000 })),
});

const neededIds = ["dep-a", "dep-b"];

const excludedArb = fc.record(
  {
    id: fc.stringMatching(/^[a-z0-9_-]{1,6}$/).filter((id) => !neededIds.includes(id)),
    mode: fc.constantFrom("inline", "evidence"),
    needs: fc.subarray(neededIds),
    severity: fc.constantFrom("block", "warn"),
    hint: fc.string({ maxLength: 200 }),
  },
  { requiredKeys: ["id", "mode"] },
);

function definition(included: fc.Arbitrary<Record<string, unknown>>) {
  return fc
    .tuple(included, excludedArb)
    .map(([fields, rest]) => ({ severity: "block", ...rest, ...fields }) as CheckDefinition);
}

describe("ハッシュに入れる前の文字列", () => {
  it("run・paths・timeout か、ファイルの一覧と内容のどれかが違えば、違う文字列になる", () => {
    const sideArb = fc.record({ check: definition(includedArb), files: lsFilesArb });
    const pairArb = fc
      .tuple(sideArb, sideArb, fc.subarray(["run", "paths", "timeout", "files"] as const))
      .map(([a, other, replaced]) => {
        const check = {
          ...other.check,
          run: a.check.run,
          paths: a.check.paths,
          timeout: a.check.timeout,
        };
        const b = { check, files: a.files };
        for (const field of replaced) {
          if (field === "files") b.files = other.files;
          else Object.assign(b.check, { [field]: other.check[field] });
        }
        return [a, b] as const;
      });

    // 区切り文字でつなぐ形の衝突は、pairArb だけではほぼ引けないので、境目をずらした組を別に作る。
    const pieceArb = fc.string({ unit: fc.constantFrom("a", "b"), minLength: 1, maxLength: 3 });
    const separatorArb = fc.constantFrom("|", ",", ":", " ", "\t", "\n", "\0", '","', '"]', "\n\n");
    const movedSeparatorArb = fc
      .tuple(sideArb, pieceArb, pieceArb, pieceArb, separatorArb, fc.boolean())
      .map(([base, x, y, z, separator, atFiles]) => {
        const side = (left: string, right: string) =>
          atFiles
            ? { check: { ...base.check, paths: [...base.check.paths, left] }, files: right }
            : {
                check: { ...base.check, run: left, paths: [right, ...base.check.paths] },
                files: base.files,
              };
        return [side(x + separator + y, z), side(x, y + separator + z)] as const;
      });

    fc.assert(
      fc.property(fc.oneof(pairArb, movedSeparatorArb), ([a, b]) => {
        const same =
          a.check.run === b.check.run &&
          JSON.stringify(a.check.paths) === JSON.stringify(b.check.paths) &&
          a.check.timeout === b.check.timeout &&
          a.files === b.files;
        if (same) return;

        expect(fingerprintSource(a.check, a.files)).not.toBe(fingerprintSource(b.check, b.files));
      }),
    );
  });
});

function shuffledObject(entries: [string, unknown][]) {
  return fc
    .shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
    .map((shuffled) => Object.fromEntries(shuffled));
}

function loadCheck(written: Record<string, unknown>): CheckDefinition {
  const needed = neededIds.map((id) => ({ id, mode: "inline", run: "true", paths: ["**"] }));
  const result = parseConfig(JSON.stringify({ checks: [written, ...needed] }));
  if (result.status !== "loaded") throw new Error(JSON.stringify(result));
  const [check] = result.config.checks;
  if (check === undefined) throw new Error("チェックがありません");
  return check;
}

describe("フィンガープリント", () => {
  it("id・mode・severity・hint・needs だけを変えても、.menou.json のキーの順番を変えても変わらない", () => {
    const arb = fc
      .tuple(
        fc.record(
          {
            run: fc.string({ minLength: 1 }),
            paths: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
            timeout: fc.integer({ min: 1, max: 100_000 }),
          },
          { requiredKeys: ["run", "paths"] },
        ),
        excludedArb,
        excludedArb,
        lsFilesArb,
      )
      .chain(([included, first, second, files]) =>
        fc.record({
          first: shuffledObject(Object.entries({ ...first, ...included })),
          second: shuffledObject(Object.entries({ ...second, ...included })),
          files: fc.constant(files),
        }),
      );

    fc.assert(
      fc.property(arb, ({ first, second, files }) => {
        const a = loadCheck(first);
        const b = loadCheck(second);

        expect(fingerprint(b, files)).toBe(fingerprint(a, files));
      }),
    );
  });
});

const treePaths = ["src/a.ts", "src/sub/b.ts", "srcx/c.ts", "lib/d.ts", "README.md"];
const contentArb = fc.constantFrom("1", "2", "3");

type Operation =
  | { kind: "write"; path: string; content: string; stage: boolean }
  | { kind: "remove"; pick: number }
  | { kind: "toggleExecutable"; pick: number }
  | { kind: "stage"; pick: number | "all" };

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant("write" as const),
    path: fc.constantFrom(...treePaths),
    content: contentArb,
    stage: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("remove" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("toggleExecutable" as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant("stage" as const),
    pick: fc.oneof(fc.nat(), fc.constant("all" as const)),
  }),
);

interface FileState {
  content: string;
  executable: boolean;
}

describe("paths が src/** のチェックを、本物の git リポジトリで計算する", () => {
  const srcCheck: CheckDefinition = {
    id: "src",
    mode: "inline",
    run: "true",
    paths: ["src/**"],
    severity: "block",
    timeout: 120,
  };

  function underSrc(model: Map<string, FileState>) {
    return JSON.stringify([...model].filter(([path]) => path.startsWith("src/")).sort());
  }

  it("src/ の下を変えたときだけ変わり、どの操作のあとでも実際のインデックスは計算の前と同じ", () => {
    const arb = fc.record({
      initial: fc.dictionary(fc.constantFrom(...treePaths), contentArb),
      operations: fc.array(operationArb, { minLength: 1, maxLength: 8 }),
    });

    fc.assert(
      fc.property(arb, ({ initial, operations }) => {
        const repo = createRepo();
        try {
          const model = new Map<string, FileState>();
          for (const [path, content] of Object.entries(initial)) {
            repo.write(path, content);
            model.set(path, { content, executable: false });
          }
          repo.commitAll();

          const measure = () => {
            const before = repo.indexBytes();
            const value = computeFingerprints(repo.root, [srcCheck]).fingerprints.get("src");
            expect(repo.indexBytes()).toEqual(before);
            return value;
          };

          let previous = measure();
          for (const operation of operations) {
            const modelBefore = underSrc(model);
            const existing = [...model.keys()].sort();
            const picked = (pick: number) => existing[pick % existing.length];

            if (operation.kind === "write") {
              repo.write(operation.path, operation.content);
              const executable = model.get(operation.path)?.executable ?? false;
              model.set(operation.path, { content: operation.content, executable });
              if (operation.stage) repo.git("add", "--", operation.path);
            } else if (operation.kind === "stage") {
              const path = operation.pick === "all" ? undefined : picked(operation.pick);
              repo.git("add", "-A", "--", path ?? ".");
            } else {
              const path = picked(operation.pick);
              const state = path === undefined ? undefined : model.get(path);
              if (path === undefined || state === undefined) continue;
              if (operation.kind === "remove") {
                repo.remove(path);
                model.delete(path);
              } else {
                repo.setExecutable(path, !state.executable);
                model.set(path, { ...state, executable: !state.executable });
              }
            }

            const current = measure();
            expect(current !== previous, JSON.stringify(operation)).toBe(
              underSrc(model) !== modelBefore,
            );
            previous = current;
          }
        } finally {
          repo.cleanup();
        }
      }),
      { numRuns: 20 },
    );
  }, 120_000);
});
