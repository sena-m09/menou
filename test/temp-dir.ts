import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";

export function testWithTempDir(prefix: string) {
  return test.extend("dir", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  });
}
