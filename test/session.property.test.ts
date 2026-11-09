import { rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, onTestFinished } from "vitest";
import { run } from "../src/cli";
import { type BlockCount, countBlock, selectBaseline } from "../src/session";
import { takeSnapshot } from "../src/snapshot";
import { resolveLocations } from "../src/store";
import { createRepo } from "./repo";

const operationArb = fc.oneof(
  fc.record({
    kind: fc.constant("start" as const),
    sessionId: fc.constantFrom("session-a", "session-b", "session-c"),
    source: fc.constantFrom("startup", "resume", "clear", "compact", "fork"),
  }),
  fc.record({
    kind: fc.constant("write" as const),
    path: fc.stringMatching(/^src\/[a-z]{1,3}\.ts$/),
    text: fc.string(),
  }),
);

describe("SessionStart で記録するベースライン", () => {
  it("どんな順で作業ツリーを変えて SessionStart を呼んでも、各セッションのベースラインは最初に呼んだときの tree のまま", async () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    repo.write(".menou.json", JSON.stringify({ checks: [] }));
    const locations = resolveLocations(repo.root);

    await fc.assert(
      fc.asyncProperty(fc.array(operationArb, { maxLength: 12 }), async (operations) => {
        rmSync(join(locations.worktreeDir, "sessions"), { recursive: true, force: true });
        const firstTrees = new Map<string, string>();

        for (const operation of operations) {
          if (operation.kind === "write") {
            repo.write(operation.path, operation.text);
            continue;
          }
          if (!firstTrees.has(operation.sessionId)) {
            firstTrees.set(operation.sessionId, takeSnapshot(repo.root, []).tree);
          }
          const code = await run(["hook", "session-start"], {
            cwd: repo.root,
            env: {},
            readStdin: () =>
              Promise.resolve(
                JSON.stringify({ session_id: operation.sessionId, source: operation.source }),
              ),
            stdout: () => {},
            stderr: () => {},
          });
          expect(code).toBe(0);
        }

        for (const [sessionId, tree] of firstTrees) {
          expect(selectBaseline(locations, sessionId)).toBe(tree);
        }
      }),
      { numRuns: 20 },
    );
  }, 120_000);
});

describe("ブロック回数の数え方", () => {
  it("同じプロンプトの中で続けてブロックするのは maxBlocks 回までで、新しいプロンプトか、不足なく通したあとは数え直す", () => {
    const stopArb = fc.record({
      promptId: fc.constantFrom("prompt-a", "prompt-b", undefined),
      short: fc.boolean(),
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(stopArb, { maxLength: 30 }),
        (maxBlocks, stops) => {
          const streak: { count: number; promptId: string | undefined } = {
            count: 0,
            promptId: undefined,
          };
          const start: BlockCount = { count: 0 };

          stops.reduce((previous, stop) => {
            const { decision, next } = countBlock(previous, { ...stop, maxBlocks });
            const continuing = streak.count > 0 && streak.promptId === stop.promptId;
            const blocksSoFar = continuing ? streak.count : 0;

            if (!stop.short) {
              expect(decision).toBe("pass");
              streak.count = 0;
            } else if (blocksSoFar < maxBlocks) {
              expect(decision).toBe("block");
              streak.count = blocksSoFar + 1;
              streak.promptId = stop.promptId;
            } else {
              expect(decision).toBe("limit");
            }
            expect(streak.count).toBeLessThanOrEqual(maxBlocks);
            return next;
          }, start);
        },
      ),
    );
  });
});
