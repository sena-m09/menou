import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../src/config";
import { computeFingerprints } from "../src/fingerprint";
import { judgeStop } from "../src/gate";
import { SessionIdSchema, recordBaseline, writeBlockCount } from "../src/session";
import { takeSnapshot } from "../src/snapshot";
import { resolveLocations, writeRecord } from "../src/store";
import { createRepo } from "./repo";

const checkArb = fc.record({
  mode: fc.constantFrom("inline", "evidence"),
  run: fc.constantFrom("exit 0", "exit 1", "exit 3"),
  paths: fc.constantFrom(["src/**"], ["**"], ["docs/*"], ["*.md"]),
  severity: fc.constantFrom("block", "warn"),
  timeout: fc.integer({ min: 1, max: 600 }),
  needsEarlier: fc.array(fc.nat(), { maxLength: 2 }),
  recorded: fc.constantFrom("none", "pass", "fail", "error"),
});

describe("作業ツリーがベースラインから変わっていないとき", () => {
  it("設定・記録・ブロック回数がどうであっても、チェックを実行せずに通す", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    const locations = resolveLocations(repo.root);

    await fc.assert(
      fc.asyncProperty(
        fc.array(checkArb, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 5 }),
        fc.nat({ max: 6 }),
        fc.dictionary(fc.constantFrom("src/a.ts", "docs/b.md", "c.md"), fc.string()),
        async (checks, maxBlocks, blockCount, files) => {
          rmSync(join(locations.worktreeDir, "sessions"), { recursive: true, force: true });
          rmSync(join(repo.root, "ran.log"), { force: true });
          for (const [path, text] of Object.entries(files)) repo.write(path, text);
          const definitions = checks.map((check, i) => ({
            id: `c${i}`,
            mode: check.mode,
            run: `echo ran >> ran.log; ${check.run}`,
            paths: check.paths,
            severity: check.severity,
            timeout: check.timeout,
            needs: [...new Set(check.needsEarlier.filter((n) => n < i).map((n) => `c${n}`))],
          }));
          repo.write(".menou.json", JSON.stringify({ maxBlocks, checks: definitions }));
          const config = loadConfig(repo.root);
          if (config.status !== "loaded") throw new Error(JSON.stringify(config));
          const { fingerprints } = computeFingerprints(repo.root, config.config.checks);
          checks.forEach((check, i) => {
            if (check.recorded === "none") return;
            writeRecord(locations, {
              id: `c${i}`,
              fingerprint: fingerprints.get(`c${i}`) ?? "",
              finishedAt: "2026-11-09T00:00:00.000Z",
              ...(check.recorded === "error"
                ? { result: "error", cause: { kind: "exit", code: 3 } }
                : { result: check.recorded }),
            });
          });
          const sessionId = v.parse(SessionIdSchema, "session-a");
          recordBaseline(locations, sessionId, () => takeSnapshot(repo.root, []).tree);
          writeBlockCount(locations, sessionId, { count: blockCount, promptId: "prompt-a" });

          const result = await judgeStop({ locations, config, sessionId, promptId: "prompt-a" });

          expect(result.decision).toBe("pass");
          expect(existsSync(join(repo.root, "ran.log"))).toBe(false);
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);
});
