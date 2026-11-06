import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const staleAfterMs = 60 * 60 * 1000;

export function temporaryName(prefix: string, createdAt = Date.now()): string {
  return `${prefix}-${createdAt}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

// 一時インデックスは mtime を実際のインデックスに合わせるので、作った時刻は名前から読む。
export function removeStaleTemporaries(dir: string, prefix: string): void {
  const pattern = new RegExp(`^${prefix}-(\\d+)-\\d+-[0-9a-f]+(\\.lock)?$`);
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const createdAt = Number(pattern.exec(name)?.[1]);
    if (now - createdAt > staleAfterMs) rmSync(join(dir, name), { force: true });
  }
}
