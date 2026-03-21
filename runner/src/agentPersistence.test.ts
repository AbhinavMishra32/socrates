import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentPersistence } from "./agentPersistence";

test("local agent persistence stores planning state, knowledge, generated blueprints, and project summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "construct-agent-persistence-"));
  const previousBackend = process.env.CONSTRUCT_STORAGE_BACKEND;
  delete process.env.DATABASE_URL;
  process.env.CONSTRUCT_STORAGE_BACKEND = "local";

  const persistence = createAgentPersistence({
    rootDirectory: root,
    logger: {
      info() {},
      warn() {},
      error() {}
    }
  });

  try {
    await persistence.setPlanningState({
      session: {
        sessionId: "session-1",
        goal: "build a C compiler in Rust",
        normalizedGoal: "build a C compiler in Rust",
        learningStyle: "concept-first",
        detectedLanguage: "rust",
        detectedDomain: "compiler",
        createdAt: "2026-03-15T00:00:00.000Z",
        questions: []
      },
      plan: null,
      answers: []
    });

    await persistence.setKnowledgeBase({
      updatedAt: "2026-03-15T00:00:00.000Z",
      concepts: [],
      goals: []
    });

    await persistence.saveGeneratedBlueprintRecord({
      sessionId: "session-1",
      goal: "build a C compiler in Rust",
      blueprintId: "blueprint-1",
      blueprintPath: path.join(root, ".construct", "generated-blueprints", "session-1", "project-blueprint.json"),
      projectRoot: path.join(root, ".construct", "generated-blueprints", "session-1"),
      blueprintJson: JSON.stringify({
        id: "blueprint-1",
        name: "Compiler",
        version: "0.1.0",
        description: "A compiler project",
        projectRoot: path.join(root, ".construct", "generated-blueprints", "session-1"),
        sourceProjectRoot: path.join(root, ".construct", "generated-blueprints", "session-1"),
        language: "Rust",
        entrypoints: ["src/main.rs"],
        files: {
          "src/main.rs": "// TASK:step-1\nfn main() {}\n"
        },
        steps: [
          {
            id: "step-1",
            title: "Intro step",
            summary: "Build the first compiler type.",
            doc: "Learn the first compiler type.",
            lessonSlides: ["## Tokens\n\nStart with a token type."],
            anchor: {
              file: "src/main.rs",
              marker: "TASK:step-1"
            },
            tests: ["tests/token.test.ts"],
            concepts: ["rust-enums"],
            constraints: [],
            checks: [],
            estimatedMinutes: 20,
            difficulty: "intro"
          }
        ],
        dependencyGraph: {
          nodes: [],
          edges: []
        },
        metadata: {
          createdBy: "Construct",
          createdAt: "2026-03-15T00:00:00.000Z",
          targetLanguage: "Rust",
          tags: ["compiler"]
        }
      }),
      planJson: JSON.stringify({
        sessionId: "session-1",
        goal: "build a C compiler in Rust",
        language: "Rust",
        domain: "compiler",
        learningStyle: "concept-first",
        summary: "Learn compiler fundamentals in order.",
        architecture: [
          {
            id: "tokens",
            label: "Tokens",
            kind: "component",
            summary: "Token representation",
            dependsOn: []
          }
        ],
        knowledgeGraph: {
          concepts: [
            {
              id: "rust-enums",
              label: "Rust enums",
              category: "language",
              path: ["rust-enums"],
              labelPath: ["Rust enums"],
              confidence: "new",
              rationale: "Needed for token representation."
            }
          ],
          strengths: [],
          gaps: ["rust-enums"]
        },
        steps: [
          {
            id: "step-1",
            title: "Intro step",
            kind: "implementation",
            objective: "Create the first token type.",
            rationale: "Needed before lexing.",
            concepts: ["rust-enums"],
            dependsOn: [],
            validationFocus: ["token-shape"],
            suggestedFiles: ["src/main.rs"],
            implementationNotes: ["Define the enum."],
            quizFocus: ["rust-enums"],
            hiddenValidationFocus: ["enum-compiles"]
          }
        ],
        suggestedFirstStepId: "step-1"
      }),
      bundleJson: JSON.stringify({
        projectName: "Compiler"
      }),
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      isActive: false
    });

    await persistence.setActiveBlueprintState({
      blueprintPath: path.join(root, ".construct", "generated-blueprints", "session-1", "project-blueprint.json"),
      sessionId: "session-1",
      updatedAt: "2026-03-15T00:00:00.000Z"
    });

    const persistedState = await persistence.getPlanningState();
    const knowledgeBase = await persistence.getKnowledgeBase();
    const activeBlueprint = await persistence.getActiveBlueprintState();
    const blueprintRecord = await persistence.getGeneratedBlueprintRecord("session-1");
    const activeProject = await persistence.getActiveProject();
    const projects = await persistence.listProjects();

    assert.equal(persistedState?.session?.goal, "build a C compiler in Rust");
    assert.equal(knowledgeBase?.updatedAt, "2026-03-15T00:00:00.000Z");
    assert.equal(activeBlueprint?.sessionId, "session-1");
    assert.equal(blueprintRecord?.isActive, true);
    assert.equal(activeProject?.id, "session-1");
    assert.equal(activeProject?.totalSteps, 1);
    assert.equal(projects.length, 1);

    await persistence.upsertBlueprintBuild({
      id: "build-1",
      sessionId: "session-1",
      userId: "local-user",
      goal: "build a C compiler in Rust",
      learningStyle: "concept-first",
      detectedLanguage: "rust",
      detectedDomain: "compiler",
      status: "running",
      currentStage: "plan-generation",
      currentStageTitle: "Synthesizing plan",
      currentStageStatus: "running",
      lastError: null,
      langSmithProject: null,
      traceUrl: null,
      planningSession: persistedState?.session ?? null,
      answers: [
        {
          questionId: "question.rust",
          answerType: "option",
          optionId: "partial"
        }
      ],
      plan: persistedState?.plan ?? null,
      blueprint: null,
      blueprintDraft: null,
      supportFiles: [],
      canonicalFiles: [],
      learnerFiles: [],
      hiddenTests: [],
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z",
      completedAt: null,
      lastEventAt: "2026-03-15T00:00:01.000Z"
    });

    await persistence.upsertBlueprintBuildStage({
      id: "build-1:plan-generation",
      buildId: "build-1",
      stage: "plan-generation",
      title: "Synthesizing plan",
      status: "completed",
      detail: "Plan complete",
      inputJson: {
        goal: "build a C compiler in Rust"
      },
      outputJson: {
        stepCount: 1
      },
      metadataJson: null,
      traceUrl: null,
      startedAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:02.000Z",
      completedAt: "2026-03-15T00:00:02.000Z"
    });

    await persistence.appendBlueprintBuildEvent({
      id: "event-1",
      buildId: "build-1",
      jobId: "job-1",
      kind: "planning-plan",
      stage: "plan-generation",
      title: "Plan complete",
      detail: "Created the roadmap",
      level: "success",
      payload: {
        stepCount: 1
      },
      traceUrl: null,
      timestamp: "2026-03-15T00:00:02.000Z"
    });

    const blueprintBuild = await persistence.getBlueprintBuild("build-1");
    const blueprintBuildBySession = await persistence.getBlueprintBuildBySession("session-1");
    const blueprintBuilds = await persistence.listBlueprintBuilds();
    const blueprintBuildDetail = await persistence.getBlueprintBuildDetail("build-1");

    assert.equal(blueprintBuild?.currentStage, "plan-generation");
    assert.equal(blueprintBuildBySession?.id, "build-1");
    assert.equal(blueprintBuilds.length, 1);
    assert.equal(blueprintBuildDetail.stages.length, 1);
    assert.equal(blueprintBuildDetail.events.length, 1);

    await persistence.updateProjectProgress({
      blueprintPath: path.join(root, ".construct", "generated-blueprints", "session-1", "project-blueprint.json"),
      stepId: "step-1",
      stepTitle: "Intro step",
      stepIndex: 0,
      totalSteps: 1,
      markStepCompleted: true,
      lastAttemptStatus: "passed"
    });

    const updatedProject = await persistence.getProject("session-1");
    assert.equal(updatedProject?.completedStepsCount, 1);
    assert.equal(updatedProject?.status, "completed");
  } finally {
    if (previousBackend) {
      process.env.CONSTRUCT_STORAGE_BACKEND = previousBackend;
    } else {
      delete process.env.CONSTRUCT_STORAGE_BACKEND;
    }

    await rm(root, { recursive: true, force: true });
  }
});

test("local agent persistence resets an invalid knowledge base to the new recursive shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "construct-agent-persistence-invalid-kb-"));
  const previousBackend = process.env.CONSTRUCT_STORAGE_BACKEND;
  delete process.env.DATABASE_URL;
  process.env.CONSTRUCT_STORAGE_BACKEND = "local";

  const persistence = createAgentPersistence({
    rootDirectory: root,
    logger: {
      info() {},
      warn() {},
      error() {}
    }
  });

  try {
    const stateDirectory = path.join(root, ".construct", "state");
    const knowledgeBasePath = path.join(stateDirectory, "user-knowledge.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      knowledgeBasePath,
      `${JSON.stringify(
        {
          updatedAt: "2026-03-16T00:00:00.000Z",
          concepts: [
            {
              id: "typescript.interfaces",
              label: "Interfaces",
              category: "language"
            }
          ],
          goals: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const knowledgeBase = await persistence.getKnowledgeBase();
    const persistedRaw = JSON.parse(await readFile(knowledgeBasePath, "utf8"));

    assert.deepEqual(knowledgeBase?.concepts, []);
    assert.deepEqual(knowledgeBase?.goals, []);
    assert.deepEqual(persistedRaw.concepts, []);
    assert.deepEqual(persistedRaw.goals, []);
  } finally {
    if (previousBackend) {
      process.env.CONSTRUCT_STORAGE_BACKEND = previousBackend;
    } else {
      delete process.env.CONSTRUCT_STORAGE_BACKEND;
    }

    await rm(root, { recursive: true, force: true });
  }
});

test("local agent persistence resets a malformed knowledge base payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "construct-agent-persistence-malformed-kb-"));
  const previousBackend = process.env.CONSTRUCT_STORAGE_BACKEND;
  delete process.env.DATABASE_URL;
  process.env.CONSTRUCT_STORAGE_BACKEND = "local";

  const persistence = createAgentPersistence({
    rootDirectory: root,
    logger: {
      info() {},
      warn() {},
      error() {}
    }
  });

  try {
    const stateDirectory = path.join(root, ".construct", "state");
    const knowledgeBasePath = path.join(stateDirectory, "user-knowledge.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(knowledgeBasePath, "{ not-valid-json", "utf8");

    const knowledgeBase = await persistence.getKnowledgeBase();
    const persistedRaw = JSON.parse(await readFile(knowledgeBasePath, "utf8"));

    assert.deepEqual(knowledgeBase?.concepts, []);
    assert.deepEqual(knowledgeBase?.goals, []);
    assert.deepEqual(persistedRaw.concepts, []);
    assert.deepEqual(persistedRaw.goals, []);
  } finally {
    if (previousBackend) {
      process.env.CONSTRUCT_STORAGE_BACKEND = previousBackend;
    } else {
      delete process.env.CONSTRUCT_STORAGE_BACKEND;
    }

    await rm(root, { recursive: true, force: true });
  }
});
