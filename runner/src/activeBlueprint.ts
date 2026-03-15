import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type ActiveBlueprintState = {
  blueprintPath: string;
  updatedAt: string;
  sessionId?: string;
};

export function getDefaultBlueprintPath(rootDirectory: string): string {
  return path.join(rootDirectory, "blueprints", "workflow-runtime", "project-blueprint.json");
}

export async function getActiveBlueprintPath(rootDirectory: string): Promise<string> {
  const statePath = getActiveBlueprintStatePath(rootDirectory);

  if (!existsSync(statePath)) {
    return getDefaultBlueprintPath(rootDirectory);
  }

  try {
    const rawState = await readFile(statePath, "utf8");
    const state = JSON.parse(rawState) as ActiveBlueprintState;

    if (typeof state.blueprintPath !== "string" || state.blueprintPath.trim().length === 0) {
      return getDefaultBlueprintPath(rootDirectory);
    }

    const resolvedBlueprintPath = path.resolve(rootDirectory, state.blueprintPath);
    return existsSync(resolvedBlueprintPath)
      ? resolvedBlueprintPath
      : getDefaultBlueprintPath(rootDirectory);
  } catch {
    return getDefaultBlueprintPath(rootDirectory);
  }
}

export async function setActiveBlueprintPath(input: {
  rootDirectory: string;
  blueprintPath: string;
  sessionId?: string;
  now?: () => Date;
}): Promise<void> {
  const statePath = getActiveBlueprintStatePath(input.rootDirectory);
  await mkdir(path.dirname(statePath), { recursive: true });

  const state: ActiveBlueprintState = {
    blueprintPath: path.resolve(input.blueprintPath),
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    sessionId: input.sessionId
  };

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getActiveBlueprintStatePath(rootDirectory: string): string {
  return path.join(rootDirectory, ".construct", "state", "active-blueprint.json");
}
