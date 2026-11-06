import { createHash } from "node:crypto";
import * as v from "valibot";
import type { CheckDefinition } from "./config";
import { CheckDefinitionSchema } from "./config-schema";
import { takeSnapshot } from "./snapshot";

export const checkFieldRoles = {
  id: "excluded",
  mode: "excluded",
  run: "included",
  paths: "included",
  needs: "excluded",
  severity: "excluded",
  timeout: "included",
  hint: "excluded",
} as const satisfies Record<keyof CheckDefinition, "included" | "excluded">;

const includedFields = v
  .parse(v.array(v.keyof(CheckDefinitionSchema)), Object.keys(checkFieldRoles))
  .filter((field) => checkFieldRoles[field] === "included");

export function fingerprintSource(check: CheckDefinition, files: string): string {
  const definition = Object.fromEntries(includedFields.map((field) => [field, check[field]]));
  return JSON.stringify({ check: definition, files });
}

export function fingerprint(check: CheckDefinition, files: string): string {
  return createHash("sha256").update(fingerprintSource(check, files)).digest("hex");
}

export interface Fingerprints {
  tree: string;
  fingerprints: Map<string, string>;
}

export function computeFingerprints(dir: string, checks: readonly CheckDefinition[]): Fingerprints {
  const { tree, files } = takeSnapshot(
    dir,
    checks.map((check) => check.paths),
  );
  return {
    tree,
    fingerprints: new Map(checks.map((check, i) => [check.id, fingerprint(check, files[i] ?? "")])),
  };
}
