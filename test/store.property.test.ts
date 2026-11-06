import fc from "fast-check";
import { describe, expect } from "vitest";
import { type CheckRecord, readRecord, resolveLocations, writeRecord } from "../src/store";
import { testWithRepo } from "./repo";

const recordArb: fc.Arbitrary<CheckRecord> = fc
  .record({
    id: fc.stringMatching(/^[a-z0-9_-]{1,20}$/),
    fingerprint: fc.stringMatching(/^[0-9a-f]{64}$/),
    finishedAt: fc
      .date({ min: new Date(0), max: new Date(8_640_000_000_000), noInvalidDate: true })
      .map((date) => date.toISOString()),
    outcome: fc.oneof(
      fc.constant({ result: "pass" as const }),
      fc.constant({ result: "fail" as const }),
      fc.record({
        result: fc.constant("error" as const),
        cause: fc.oneof(
          fc.record({ kind: fc.constant("exit" as const), code: fc.integer({ min: 2, max: 255 }) }),
          fc.record({ kind: fc.constant("signal" as const), signal: fc.string() }),
          fc.record({ kind: fc.constant("timeout" as const), seconds: fc.integer({ min: 1 }) }),
          fc.record({ kind: fc.constant("spawn" as const), message: fc.string() }),
          fc.constant({ kind: "modified" as const }),
        ),
      }),
    ),
  })
  .map(({ outcome, ...rest }) => ({ ...rest, ...outcome }));

const it = testWithRepo().extend("locations", ({ repo }) => resolveLocations(repo.root));

describe("記録", () => {
  it("書いて読み直すと、同じ内容が返る", ({ locations }) => {
    fc.assert(
      fc.property(recordArb, (record) => {
        writeRecord(locations, record);

        expect(readRecord(locations, record.id, record.fingerprint)).toEqual(record);
      }),
    );
  });
});
