import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareLearnerWorkspace } from "./workspaceMaterializer";

const EXCLUDED_FIXTURE_ENTRIES = new Set([".construct", "node_modules", "test-fixtures"]);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const canonicalBlueprintPath = path.join(
  rootDir,
  "blueprints",
  "workflow-runtime",
  "project-blueprint.json"
);

test("prepareLearnerWorkspace materializes starter files while retaining hidden tests", async () => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "construct-materialize-"));
  const isolatedBlueprintRoot = path.join(isolatedRoot, "blueprints", "workflow-runtime");
  const isolatedBlueprintPath = path.join(isolatedBlueprintRoot, "project-blueprint.json");

  try {
    await rm(path.join(isolatedRoot, "blueprints"), { recursive: true, force: true });
    await copyBlueprintProject(isolatedBlueprintRoot);

    const prepared = await prepareLearnerWorkspace(isolatedBlueprintPath);
    const learnerState = await readFile(
      path.join(prepared.learnerWorkspaceRoot, "src", "state.ts"),
      "utf8"
    );
    const hiddenTest = await readFile(
      path.join(prepared.learnerWorkspaceRoot, "tests", "state.test.ts"),
      "utf8"
    );

    assert.match(learnerState, /throw new Error\('Implement mergeState'\)/);
    assert.match(hiddenTest, /mergeState/);
    assert.equal(
      prepared.learnerBlueprintPath,
      path.join(prepared.learnerWorkspaceRoot, "project-blueprint.json")
    );
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

async function copyBlueprintProject(destinationRoot: string): Promise<void> {
  const sourceRoot = path.dirname(canonicalBlueprintPath);
  const { cp, mkdir } = await import("node:fs/promises");

  await mkdir(path.dirname(destinationRoot), { recursive: true });
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    filter(sourcePath) {
      return !EXCLUDED_FIXTURE_ENTRIES.has(path.basename(sourcePath));
    }
  });
}
