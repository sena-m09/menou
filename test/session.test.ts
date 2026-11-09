import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { describe, expect, it, onTestFinished } from "vitest";
import { SessionIdSchema, readBlockCount, writeBlockCount } from "../src/session";
import { resolveLocations } from "../src/store";
import { createRepo } from "./repo";

describe("ブロック回数のファイル", () => {
  it("書いた回数とプロンプトの ID を、同じセッション ID で読み直せる", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    const locations = resolveLocations(repo.root);
    const sessionId = v.parse(SessionIdSchema, "session-a");

    writeBlockCount(locations, sessionId, { count: 2, promptId: "prompt-a" });

    expect(readBlockCount(locations, sessionId)).toEqual({ count: 2, promptId: "prompt-a" });
  });

  it("別のセッション ID の回数は読まない", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    const locations = resolveLocations(repo.root);

    writeBlockCount(locations, v.parse(SessionIdSchema, "session-a"), { count: 2 });

    expect(readBlockCount(locations, v.parse(SessionIdSchema, "session-b"))).toEqual({
      count: 0,
    });
  });

  it("まだ書いていなければ、0 回として扱う", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    const locations = resolveLocations(repo.root);

    expect(readBlockCount(locations, v.parse(SessionIdSchema, "session-a"))).toEqual({
      count: 0,
    });
  });

  it("中身が読めなければ、0 回として扱う", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    const locations = resolveLocations(repo.root);
    mkdirSync(join(locations.worktreeDir, "sessions", "session-a"), { recursive: true });
    writeFileSync(join(locations.worktreeDir, "sessions", "session-a", "blocks.json"), "{");

    expect(readBlockCount(locations, v.parse(SessionIdSchema, "session-a"))).toEqual({
      count: 0,
    });
  });

  it("書き終えたら、一時ファイルを残さない", () => {
    const repo = createRepo();
    onTestFinished(() => repo.cleanup());
    const locations = resolveLocations(repo.root);

    writeBlockCount(locations, v.parse(SessionIdSchema, "session-a"), { count: 1 });

    expect(readdirSync(locations.worktreeDir).filter((name) => name.startsWith("blocks-"))).toEqual(
      [],
    );
  });
});
