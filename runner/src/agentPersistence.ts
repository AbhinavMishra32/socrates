import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CurrentPlanningSessionResponseSchema,
  GeneratedProjectPlanSchema,
  ProjectAttemptStatusSchema,
  ProjectBlueprintSchema,
  ProjectSummarySchema,
  UserKnowledgeBaseSchema,
  type CurrentPlanningSessionResponse,
  type GeneratedProjectPlan,
  type ProjectAttemptStatus,
  type ProjectStatus as SharedProjectStatus,
  type ProjectSummary,
  type UserKnowledgeBase
} from "@construct/shared";
import { z } from "zod";

import { createEmptyKnowledgeBase } from "./knowledgeGraph";
import { getPrismaClient } from "./prisma";

const ActiveBlueprintStateSchema = z.object({
  blueprintPath: z.string().min(1),
  updatedAt: z.string().datetime(),
  sessionId: z.string().min(1).optional()
});

const PersistedGeneratedBlueprintRecordSchema = z.object({
  sessionId: z.string().min(1),
  goal: z.string().min(1),
  blueprintId: z.string().min(1),
  blueprintPath: z.string().min(1),
  projectRoot: z.string().min(1),
  blueprintJson: z.string().min(1),
  planJson: z.string().min(1),
  bundleJson: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  isActive: z.boolean().default(false)
});

const PersistedGeneratedBlueprintRecordListSchema = z.array(
  PersistedGeneratedBlueprintRecordSchema
);

const PersistedProjectRecordSchema = ProjectSummarySchema.omit({
  completedStepsCount: true
}).extend({
  blueprintId: z.string().min(1),
  learningStyle: z.string().min(1).nullable().default(null),
  completedStepIds: z.array(z.string().min(1)).default([]),
  blueprintJson: z.string().min(1),
  planJson: z.string().min(1),
  bundleJson: z.string().min(1)
});

const PersistedProjectRecordListSchema = z.array(PersistedProjectRecordSchema);

export type ActiveBlueprintState = z.infer<typeof ActiveBlueprintStateSchema>;
export type PersistedGeneratedBlueprintRecord = z.infer<
  typeof PersistedGeneratedBlueprintRecordSchema
>;

type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;

export type ProjectProgressUpdate = {
  blueprintPath: string;
  stepId: string;
  stepTitle: string;
  stepIndex: number;
  totalSteps: number;
  markStepCompleted?: boolean;
  lastAttemptStatus?: ProjectAttemptStatus | null;
};

export type AgentPersistence = {
  getPlanningState(): Promise<CurrentPlanningSessionResponse | null>;
  setPlanningState(state: CurrentPlanningSessionResponse): Promise<void>;
  getPlanningBuildCheckpoint(sessionId: string): Promise<unknown | null>;
  setPlanningBuildCheckpoint(sessionId: string, checkpoint: unknown): Promise<void>;
  clearPlanningBuildCheckpoint(sessionId: string): Promise<void>;
  getKnowledgeBase(): Promise<UserKnowledgeBase | null>;
  setKnowledgeBase(knowledgeBase: UserKnowledgeBase): Promise<void>;
  getActiveBlueprintState(): Promise<ActiveBlueprintState | null>;
  setActiveBlueprintState(state: ActiveBlueprintState): Promise<void>;
  getGeneratedBlueprintRecord(sessionId: string): Promise<PersistedGeneratedBlueprintRecord | null>;
  saveGeneratedBlueprintRecord(record: PersistedGeneratedBlueprintRecord): Promise<void>;
  listProjects(): Promise<ProjectSummary[]>;
  getActiveProject(): Promise<ProjectSummary | null>;
  getProject(projectId: string): Promise<ProjectSummary | null>;
  setActiveProject(projectId: string): Promise<ProjectSummary | null>;
  updateProjectProgress(update: ProjectProgressUpdate): Promise<ProjectSummary | null>;
};

type AgentPersistenceLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

type AgentPersistenceInput = {
  rootDirectory: string;
  logger: AgentPersistenceLogger;
};

type StorageBackend = "local" | "prisma";

export function createAgentPersistence(input: AgentPersistenceInput): AgentPersistence {
  const backend = resolveStorageBackend();

  input.logger.info("Initializing agent persistence.", {
    backend,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL?.trim())
  });

  if (backend === "prisma") {
    const databaseUrl = process.env.DATABASE_URL?.trim();

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required when CONSTRUCT_STORAGE_BACKEND=prisma."
      );
    }

    return new PrismaAgentPersistence(input.logger);
  }

  return new LocalFileAgentPersistence(input.rootDirectory, input.logger);
}

class LocalFileAgentPersistence implements AgentPersistence {
  private readonly stateDirectory: string;
  private readonly planningStatePath: string;
  private readonly planningBuildCheckpointPath: string;
  private readonly knowledgeBasePath: string;
  private readonly activeBlueprintStatePath: string;
  private readonly blueprintRecordsPath: string;
  private readonly projectsPath: string;
  private readonly logger: AgentPersistenceLogger;

  constructor(rootDirectory: string, logger: AgentPersistenceLogger) {
    this.stateDirectory = path.join(rootDirectory, ".construct", "state");
    this.planningStatePath = path.join(this.stateDirectory, "agent-planner.json");
    this.planningBuildCheckpointPath = path.join(
      this.stateDirectory,
      "planning-build-checkpoints.json"
    );
    this.knowledgeBasePath = path.join(this.stateDirectory, "user-knowledge.json");
    this.activeBlueprintStatePath = path.join(this.stateDirectory, "active-blueprint.json");
    this.blueprintRecordsPath = path.join(this.stateDirectory, "generated-blueprints.json");
    this.projectsPath = path.join(this.stateDirectory, "projects.json");
    this.logger = logger;
  }

  async getPlanningState(): Promise<CurrentPlanningSessionResponse | null> {
    if (!existsSync(this.planningStatePath)) {
      return null;
    }

    const raw = await readFile(this.planningStatePath, "utf8");
    return CurrentPlanningSessionResponseSchema.parse(JSON.parse(raw));
  }

  async setPlanningState(state: CurrentPlanningSessionResponse): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(this.planningStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async getPlanningBuildCheckpoint(sessionId: string): Promise<unknown | null> {
    const checkpoints = await this.readPlanningBuildCheckpoints();
    return checkpoints[sessionId] ?? null;
  }

  async setPlanningBuildCheckpoint(sessionId: string, checkpoint: unknown): Promise<void> {
    const checkpoints = await this.readPlanningBuildCheckpoints();
    checkpoints[sessionId] = checkpoint;
    await this.writePlanningBuildCheckpoints(checkpoints);
  }

  async clearPlanningBuildCheckpoint(sessionId: string): Promise<void> {
    const checkpoints = await this.readPlanningBuildCheckpoints();
    if (!(sessionId in checkpoints)) {
      return;
    }

    delete checkpoints[sessionId];
    await this.writePlanningBuildCheckpoints(checkpoints);
  }

  async getKnowledgeBase(): Promise<UserKnowledgeBase | null> {
    if (!existsSync(this.knowledgeBasePath)) {
      return null;
    }

    try {
      const raw = await readFile(this.knowledgeBasePath, "utf8");
      const parsed = UserKnowledgeBaseSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data;
      }

      this.logger.warn("Stored knowledge base was invalid. Resetting to empty recursive graph.", {
        backend: "local",
        userId: getCurrentUserId(),
        issueCount: parsed.error.issues.length
      });
    } catch (error) {
      this.logger.warn("Stored knowledge base could not be read. Resetting to empty recursive graph.", {
        backend: "local",
        userId: getCurrentUserId(),
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const reset = createEmptyKnowledgeBase(new Date().toISOString());
    await this.setKnowledgeBase(reset);
    return reset;
  }

  async setKnowledgeBase(knowledgeBase: UserKnowledgeBase): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(
      this.knowledgeBasePath,
      `${JSON.stringify(knowledgeBase, null, 2)}\n`,
      "utf8"
    );
  }

  async getActiveBlueprintState(): Promise<ActiveBlueprintState | null> {
    if (!existsSync(this.activeBlueprintStatePath)) {
      return null;
    }

    const raw = await readFile(this.activeBlueprintStatePath, "utf8");
    return ActiveBlueprintStateSchema.parse(JSON.parse(raw));
  }

  async setActiveBlueprintState(state: ActiveBlueprintState): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(
      this.activeBlueprintStatePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8"
    );

    const records = await this.readBlueprintRecords();
    const nextRecords = records.map((record) => ({
      ...record,
      isActive:
        record.sessionId === state.sessionId || record.blueprintPath === state.blueprintPath
    }));
    await this.writeBlueprintRecords(nextRecords);

    const projects = await this.readProjects();
    const nextProjects = sortProjectRecords(
      projects.map((project) => ({
        ...project,
        isActive:
          project.id === state.sessionId || project.blueprintPath === state.blueprintPath,
        lastOpenedAt:
          project.id === state.sessionId || project.blueprintPath === state.blueprintPath
            ? state.updatedAt
            : project.lastOpenedAt
      }))
    );
    await this.writeProjects(nextProjects);
  }

  async getGeneratedBlueprintRecord(
    sessionId: string
  ): Promise<PersistedGeneratedBlueprintRecord | null> {
    const records = await this.readBlueprintRecords();
    return records.find((record) => record.sessionId === sessionId) ?? null;
  }

  async saveGeneratedBlueprintRecord(
    record: PersistedGeneratedBlueprintRecord
  ): Promise<void> {
    const parsed = PersistedGeneratedBlueprintRecordSchema.parse(record);
    const records = await this.readBlueprintRecords();
    const nextRecords = records.filter(
      (existingRecord) => existingRecord.sessionId !== parsed.sessionId
    );
    nextRecords.unshift(parsed);
    await this.writeBlueprintRecords(nextRecords);

    const projects = await this.readProjects();
    const nextProjects = upsertProjectRecord(
      projects,
      buildProjectRecordFromGeneratedRecord(parsed)
    );
    await this.writeProjects(nextProjects);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.readProjects();
    return sortProjectRecords(projects)
      .map(toProjectSummary)
      .filter((project): project is ProjectSummary => Boolean(project));
  }

  async getActiveProject(): Promise<ProjectSummary | null> {
    const projects = await this.readProjects();
    return toProjectSummary(projects.find((project) => project.isActive) ?? null);
  }

  async getProject(projectId: string): Promise<ProjectSummary | null> {
    const projects = await this.readProjects();
    return toProjectSummary(projects.find((project) => project.id === projectId) ?? null);
  }

  async setActiveProject(projectId: string): Promise<ProjectSummary | null> {
    const projects = await this.readProjects();
    const timestamp = new Date().toISOString();
    const nextProjects = sortProjectRecords(
      projects.map((project) => {
        const isActive = project.id === projectId;
        return {
          ...project,
          isActive,
          lastOpenedAt: isActive ? timestamp : project.lastOpenedAt,
          updatedAt: isActive ? timestamp : project.updatedAt
        };
      })
    );
    const nextActiveProject =
      nextProjects.find((project) => project.id === projectId) ?? null;

    await this.writeProjects(nextProjects);

    if (nextActiveProject) {
      await this.setActiveBlueprintState({
        blueprintPath: nextActiveProject.blueprintPath,
        sessionId: nextActiveProject.id,
        updatedAt: timestamp
      });
    }

    return toProjectSummary(nextActiveProject);
  }

  async updateProjectProgress(update: ProjectProgressUpdate): Promise<ProjectSummary | null> {
    const projects = await this.readProjects();
    const normalizedBlueprintPath = path.resolve(update.blueprintPath);
    let nextProject: PersistedProjectRecord | null = null;
    const timestamp = new Date().toISOString();
    const nextProjects = sortProjectRecords(
      projects.map((project) => {
        if (path.resolve(project.blueprintPath) !== normalizedBlueprintPath) {
          return project;
        }

        const completedStepIds = update.markStepCompleted
          ? Array.from(new Set([...project.completedStepIds, update.stepId]))
          : project.completedStepIds;
        const status = deriveProjectStatus(completedStepIds.length, update.totalSteps);

        nextProject = {
          ...project,
          currentStepId: update.stepId,
          currentStepTitle: update.stepTitle,
          currentStepIndex: update.stepIndex,
          totalSteps: update.totalSteps,
          completedStepIds,
          status,
          lastAttemptStatus: update.lastAttemptStatus ?? project.lastAttemptStatus,
          updatedAt: timestamp,
          lastOpenedAt: timestamp
        };

        return nextProject;
      })
    );

    await this.writeProjects(nextProjects);
    return toProjectSummary(nextProject);
  }

  private async readBlueprintRecords(): Promise<PersistedGeneratedBlueprintRecord[]> {
    if (!existsSync(this.blueprintRecordsPath)) {
      return [];
    }

    const raw = await readFile(this.blueprintRecordsPath, "utf8");
    return PersistedGeneratedBlueprintRecordListSchema.parse(JSON.parse(raw));
  }

  private async writeBlueprintRecords(
    records: PersistedGeneratedBlueprintRecord[]
  ): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(
      this.blueprintRecordsPath,
      `${JSON.stringify(records, null, 2)}\n`,
      "utf8"
    );
  }

  private async readProjects(): Promise<PersistedProjectRecord[]> {
    if (!existsSync(this.projectsPath)) {
      return [];
    }

    const raw = await readFile(this.projectsPath, "utf8");
    return PersistedProjectRecordListSchema.parse(JSON.parse(raw));
  }

  private async writeProjects(records: PersistedProjectRecord[]): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(this.projectsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  private async readPlanningBuildCheckpoints(): Promise<Record<string, unknown>> {
    if (!existsSync(this.planningBuildCheckpointPath)) {
      return {};
    }

    const raw = await readFile(this.planningBuildCheckpointPath, "utf8");
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  }

  private async writePlanningBuildCheckpoints(
    checkpoints: Record<string, unknown>
  ): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    await writeFile(
      this.planningBuildCheckpointPath,
      `${JSON.stringify(checkpoints, null, 2)}\n`,
      "utf8"
    );
  }
}

class PrismaAgentPersistence implements AgentPersistence {
  private readonly prisma = getPrismaClient();
  private readonly userId: string;
  private readonly logger: AgentPersistenceLogger;

  constructor(logger: AgentPersistenceLogger) {
    this.userId = getCurrentUserId();
    this.logger = logger;
  }

  async getPlanningState(): Promise<CurrentPlanningSessionResponse | null> {
    const row = await this.prisma.constructState.findUnique({
      where: {
        key: toStateKey(this.userId, "planning_state")
      }
    });

    return row ? CurrentPlanningSessionResponseSchema.parse(JSON.parse(row.valueJson)) : null;
  }

  async setPlanningState(state: CurrentPlanningSessionResponse): Promise<void> {
    await this.prisma.constructState.upsert({
      where: {
        key: toStateKey(this.userId, "planning_state")
      },
      create: {
        key: toStateKey(this.userId, "planning_state"),
        valueJson: JSON.stringify(state)
      },
      update: {
        valueJson: JSON.stringify(state)
      }
    });
  }

  async getPlanningBuildCheckpoint(sessionId: string): Promise<unknown | null> {
    const row = await this.prisma.constructState.findUnique({
      where: {
        key: toStateKey(this.userId, `planning_build_checkpoint:${sessionId}`)
      }
    });

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.valueJson);
    } catch (error) {
      this.logger.warn("Stored planning build checkpoint could not be read. Clearing it.", {
        backend: "prisma",
        userId: this.userId,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.clearPlanningBuildCheckpoint(sessionId);
      return null;
    }
  }

  async setPlanningBuildCheckpoint(sessionId: string, checkpoint: unknown): Promise<void> {
    await this.prisma.constructState.upsert({
      where: {
        key: toStateKey(this.userId, `planning_build_checkpoint:${sessionId}`)
      },
      create: {
        key: toStateKey(this.userId, `planning_build_checkpoint:${sessionId}`),
        valueJson: JSON.stringify(checkpoint)
      },
      update: {
        valueJson: JSON.stringify(checkpoint)
      }
    });
  }

  async clearPlanningBuildCheckpoint(sessionId: string): Promise<void> {
    await this.prisma.constructState.deleteMany({
      where: {
        key: toStateKey(this.userId, `planning_build_checkpoint:${sessionId}`)
      }
    });
  }

  async getKnowledgeBase(): Promise<UserKnowledgeBase | null> {
    const row = await this.prisma.constructState.findUnique({
      where: {
        key: toStateKey(this.userId, "knowledge_base")
      }
    });

    if (!row) {
      return null;
    }

    try {
      const parsed = UserKnowledgeBaseSchema.safeParse(JSON.parse(row.valueJson));
      if (parsed.success) {
        return parsed.data;
      }

      this.logger.warn("Stored knowledge base was invalid. Resetting to empty recursive graph.", {
        backend: "prisma",
        userId: this.userId,
        issueCount: parsed.error.issues.length
      });
    } catch (error) {
      this.logger.warn("Stored knowledge base could not be read. Resetting to empty recursive graph.", {
        backend: "prisma",
        userId: this.userId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const reset = createEmptyKnowledgeBase(new Date().toISOString());
    await this.setKnowledgeBase(reset);
    return reset;
  }

  async setKnowledgeBase(knowledgeBase: UserKnowledgeBase): Promise<void> {
    await this.prisma.constructState.upsert({
      where: {
        key: toStateKey(this.userId, "knowledge_base")
      },
      create: {
        key: toStateKey(this.userId, "knowledge_base"),
        valueJson: JSON.stringify(knowledgeBase)
      },
      update: {
        valueJson: JSON.stringify(knowledgeBase)
      }
    });
  }

  async getActiveBlueprintState(): Promise<ActiveBlueprintState | null> {
    const project = await this.prisma.project.findFirst({
      where: {
        userId: this.userId,
        isActive: true
      },
      orderBy: {
        updatedAt: "desc"
      }
    });

    if (!project) {
      return null;
    }

    return ActiveBlueprintStateSchema.parse({
      blueprintPath: project.blueprintPath,
      updatedAt: project.updatedAt.toISOString(),
      sessionId: project.id
    });
  }

  async setActiveBlueprintState(state: ActiveBlueprintState): Promise<void> {
    const resolvedBlueprintPath = path.resolve(state.blueprintPath);
    const activeProjectWhere = state.sessionId
      ? {
          OR: [
            {
              id: state.sessionId
            },
            {
              blueprintPath: resolvedBlueprintPath
            }
          ]
        }
      : {
          blueprintPath: resolvedBlueprintPath
        };

    await this.prisma.$transaction([
      this.prisma.project.updateMany({
        where: {
          userId: this.userId
        },
        data: {
          isActive: false
        }
      }),
      this.prisma.project.updateMany({
        where: {
          userId: this.userId,
          ...activeProjectWhere
        },
        data: {
          isActive: true,
          lastOpenedAt: new Date(state.updatedAt)
        }
      })
    ]);
  }

  async getGeneratedBlueprintRecord(
    sessionId: string
  ): Promise<PersistedGeneratedBlueprintRecord | null> {
    const project = await this.prisma.project.findFirst({
      where: {
        userId: this.userId,
        id: sessionId
      }
    });

    return project ? toGeneratedBlueprintRecord(project) : null;
  }

  async saveGeneratedBlueprintRecord(
    record: PersistedGeneratedBlueprintRecord
  ): Promise<void> {
    const parsed = PersistedGeneratedBlueprintRecordSchema.parse(record);
    const projectRecord = buildProjectRecordFromGeneratedRecord(parsed);

    const operations = [];

    if (parsed.isActive) {
      operations.push(
        this.prisma.project.updateMany({
          where: {
            userId: this.userId
          },
          data: {
            isActive: false
          }
        })
      );
    }

    operations.push(
      this.prisma.project.upsert({
        where: {
          id: projectRecord.id
        },
        create: mapProjectCreateInput(this.userId, projectRecord),
        update: mapProjectUpdateInput(projectRecord)
      })
    );

    await this.prisma.$transaction(operations);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        userId: this.userId
      },
      orderBy: [
        {
          lastOpenedAt: "desc"
        },
        {
          updatedAt: "desc"
        }
      ]
    });

    return projects.map(toProjectSummaryFromPrisma);
  }

  async getActiveProject(): Promise<ProjectSummary | null> {
    const project = await this.prisma.project.findFirst({
      where: {
        userId: this.userId,
        isActive: true
      },
      orderBy: {
        updatedAt: "desc"
      }
    });

    return project ? toProjectSummaryFromPrisma(project) : null;
  }

  async getProject(projectId: string): Promise<ProjectSummary | null> {
    const project = await this.prisma.project.findFirst({
      where: {
        userId: this.userId,
        id: projectId
      }
    });

    return project ? toProjectSummaryFromPrisma(project) : null;
  }

  async setActiveProject(projectId: string): Promise<ProjectSummary | null> {
    const timestamp = new Date();

    await this.prisma.$transaction([
      this.prisma.project.updateMany({
        where: {
          userId: this.userId
        },
        data: {
          isActive: false
        }
      }),
      this.prisma.project.updateMany({
        where: {
          userId: this.userId,
          id: projectId
        },
        data: {
          isActive: true,
          lastOpenedAt: timestamp
        }
      })
    ]);

    return this.getProject(projectId);
  }

  async updateProjectProgress(update: ProjectProgressUpdate): Promise<ProjectSummary | null> {
    const resolvedBlueprintPath = path.resolve(update.blueprintPath);
    const project = await this.prisma.project.findFirst({
      where: {
        userId: this.userId,
        blueprintPath: resolvedBlueprintPath
      }
    });

    if (!project) {
      return null;
    }

    const currentCompletedStepIds = parseCompletedStepIdsFromPrisma(project.completedStepIds);
    const completedStepIds = update.markStepCompleted
      ? Array.from(new Set([...currentCompletedStepIds, update.stepId]))
      : currentCompletedStepIds;
    const status = sharedStatusToPrismaStatus(
      deriveProjectStatus(completedStepIds.length, update.totalSteps)
    );
    const updatedProject = await this.prisma.project.update({
      where: {
        id: project.id
      },
      data: {
        currentStepId: update.stepId,
        currentStepTitle: update.stepTitle,
        currentStepIndex: update.stepIndex,
        totalSteps: update.totalSteps,
        completedStepIds: JSON.stringify(completedStepIds),
        status,
        lastAttemptStatus: update.lastAttemptStatus ?? project.lastAttemptStatus,
        lastOpenedAt: new Date()
      }
    });

    return toProjectSummaryFromPrisma(updatedProject);
  }
}

function resolveStorageBackend(): StorageBackend {
  const configuredBackend = process.env.CONSTRUCT_STORAGE_BACKEND?.trim().toLowerCase();

  if (configuredBackend === "local") {
    return "local";
  }

  if (configuredBackend === "prisma" || configuredBackend === "neon") {
    return "prisma";
  }

  return process.env.DATABASE_URL?.trim() ? "prisma" : "local";
}

function buildProjectRecordFromGeneratedRecord(
  record: PersistedGeneratedBlueprintRecord
): PersistedProjectRecord {
  const blueprint = ProjectBlueprintSchema.parse(JSON.parse(record.blueprintJson));
  const plan = GeneratedProjectPlanSchema.parse(JSON.parse(record.planJson));
  const initialStep =
    blueprint.steps.find((step) => step.id === plan.suggestedFirstStepId) ?? blueprint.steps[0];
  const timestamp = record.updatedAt;

  return PersistedProjectRecordSchema.parse({
    id: record.sessionId,
    goal: record.goal,
    name: blueprint.name,
    description: blueprint.description,
    language: blueprint.language,
    blueprintId: record.blueprintId,
    blueprintPath: path.resolve(record.blueprintPath),
    projectRoot: path.resolve(record.projectRoot),
    learningStyle: plan.learningStyle,
    currentStepId: initialStep?.id ?? null,
    currentStepTitle: initialStep?.title ?? null,
    currentStepIndex: initialStep
      ? Math.max(
          0,
          blueprint.steps.findIndex((step) => step.id === initialStep.id)
        )
      : null,
    totalSteps: blueprint.steps.length,
    completedStepIds: [],
    status: "in-progress",
    lastAttemptStatus: null,
    blueprintJson: record.blueprintJson,
    planJson: record.planJson,
    bundleJson: record.bundleJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.isActive ? timestamp : null,
    isActive: record.isActive
  });
}

function upsertProjectRecord(
  records: PersistedProjectRecord[],
  record: PersistedProjectRecord
): PersistedProjectRecord[] {
  const nextRecords = records.filter((existing) => existing.id !== record.id);
  nextRecords.unshift(record);

  if (!record.isActive) {
    return sortProjectRecords(nextRecords);
  }

  return sortProjectRecords(
    nextRecords.map((existing) => ({
      ...existing,
      isActive: existing.id === record.id
    }))
  );
}

function sortProjectRecords(records: PersistedProjectRecord[]): PersistedProjectRecord[] {
  return [...records].sort((left, right) => {
    const leftTimestamp = left.lastOpenedAt ?? left.updatedAt;
    const rightTimestamp = right.lastOpenedAt ?? right.updatedAt;
    return Date.parse(rightTimestamp) - Date.parse(leftTimestamp);
  });
}

function deriveProjectStatus(
  completedStepsCount: number,
  totalSteps: number
): SharedProjectStatus {
  if (totalSteps > 0 && completedStepsCount >= totalSteps) {
    return "completed";
  }

  return "in-progress";
}

function toProjectSummary(record: PersistedProjectRecord | null): ProjectSummary | null {
  if (!record) {
    return null;
  }

  return ProjectSummarySchema.parse({
    id: record.id,
    goal: record.goal,
    name: record.name,
    description: record.description,
    language: record.language,
    blueprintPath: record.blueprintPath,
    projectRoot: record.projectRoot,
    currentStepId: record.currentStepId,
    currentStepTitle: record.currentStepTitle,
    currentStepIndex: record.currentStepIndex,
    totalSteps: record.totalSteps,
    completedStepsCount: record.completedStepIds.length,
    status: record.status,
    lastAttemptStatus: record.lastAttemptStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.lastOpenedAt,
    isActive: record.isActive
  });
}

function sharedStatusToPrismaStatus(status: SharedProjectStatus): string {
  switch (status) {
    case "draft":
      return "DRAFT";
    case "completed":
      return "COMPLETED";
    case "archived":
      return "ARCHIVED";
    case "in-progress":
    default:
      return "IN_PROGRESS";
  }
}

function prismaStatusToSharedStatus(status: string): SharedProjectStatus {
  if (status === "DRAFT") {
    return "draft";
  }

  if (status === "COMPLETED") {
    return "completed";
  }

  if (status === "ARCHIVED") {
    return "archived";
  }

  return "in-progress";
}

function mapProjectCreateInput(userId: string, record: PersistedProjectRecord) {
  return {
    id: record.id,
    userId,
    goal: record.goal,
    name: record.name,
    slug: slugify(record.name || record.goal),
    description: record.description,
    language: record.language,
    blueprintId: record.blueprintId,
    blueprintPath: path.resolve(record.blueprintPath),
    projectRoot: path.resolve(record.projectRoot),
    learningStyle: record.learningStyle,
    currentStepId: record.currentStepId,
    currentStepTitle: record.currentStepTitle,
    currentStepIndex: record.currentStepIndex,
    totalSteps: record.totalSteps,
    completedStepIds: JSON.stringify(record.completedStepIds),
    status: sharedStatusToPrismaStatus(record.status),
    lastAttemptStatus: record.lastAttemptStatus,
    blueprintJson: record.blueprintJson,
    planJson: record.planJson,
    bundleJson: record.bundleJson,
    isActive: record.isActive,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    lastOpenedAt: record.lastOpenedAt ? new Date(record.lastOpenedAt) : null
  };
}

function mapProjectUpdateInput(record: PersistedProjectRecord) {
  return {
    goal: record.goal,
    name: record.name,
    slug: slugify(record.name || record.goal),
    description: record.description,
    language: record.language,
    blueprintId: record.blueprintId,
    blueprintPath: path.resolve(record.blueprintPath),
    projectRoot: path.resolve(record.projectRoot),
    learningStyle: record.learningStyle,
    currentStepId: record.currentStepId,
    currentStepTitle: record.currentStepTitle,
    currentStepIndex: record.currentStepIndex,
    totalSteps: record.totalSteps,
    completedStepIds: JSON.stringify(record.completedStepIds),
    status: sharedStatusToPrismaStatus(record.status),
    lastAttemptStatus: record.lastAttemptStatus,
    blueprintJson: record.blueprintJson,
    planJson: record.planJson,
    bundleJson: record.bundleJson,
    isActive: record.isActive,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    lastOpenedAt: record.lastOpenedAt ? new Date(record.lastOpenedAt) : null
  };
}

function toProjectSummaryFromPrisma(project: {
  id: string;
  goal: string;
  name: string;
  description: string;
  language: string;
  blueprintPath: string;
  projectRoot: string;
  currentStepId: string | null;
  currentStepTitle: string | null;
  currentStepIndex: number | null;
  totalSteps: number;
  completedStepIds: string;
  status: string;
  lastAttemptStatus: string | null;
  blueprintJson: string;
  planJson: string;
  bundleJson: string;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date | null;
  isActive: boolean;
}): ProjectSummary {
  const blueprint = parseBlueprintSummary(project.blueprintJson);
  const derivedStep = parseCurrentStepSummary(project.blueprintJson, project.planJson);
  const lastAttemptStatus = project.lastAttemptStatus
    ? ProjectAttemptStatusSchema.parse(project.lastAttemptStatus)
    : null;
  const completedStepIds = parseCompletedStepIdsFromPrisma(project.completedStepIds);
  const name = project.name.trim() || blueprint.name;
  const description = project.description.trim() || blueprint.description;
  const language = project.language.trim() || blueprint.language;
  const currentStepId = project.currentStepId ?? derivedStep.id;
  const currentStepTitle = project.currentStepTitle ?? derivedStep.title;
  const currentStepIndex = project.currentStepIndex ?? derivedStep.index;
  const totalSteps = project.totalSteps > 0 ? project.totalSteps : derivedStep.totalSteps;

  return ProjectSummarySchema.parse({
    id: project.id,
    goal: project.goal,
    name,
    description,
    language,
    blueprintPath: project.blueprintPath,
    projectRoot: project.projectRoot,
    currentStepId,
    currentStepTitle,
    currentStepIndex,
    totalSteps,
    completedStepsCount: completedStepIds.length,
    status: prismaStatusToSharedStatus(project.status),
    lastAttemptStatus,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    lastOpenedAt: project.lastOpenedAt?.toISOString() ?? null,
    isActive: project.isActive
  });
}

function toGeneratedBlueprintRecord(project: {
  id: string;
  goal: string;
  blueprintId: string;
  blueprintPath: string;
  projectRoot: string;
  blueprintJson: string;
  planJson: string;
  bundleJson: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}): PersistedGeneratedBlueprintRecord {
  return PersistedGeneratedBlueprintRecordSchema.parse({
    sessionId: project.id,
    goal: project.goal,
    blueprintId: project.blueprintId,
    blueprintPath: project.blueprintPath,
    projectRoot: project.projectRoot,
    blueprintJson: project.blueprintJson,
    planJson: project.planJson,
    bundleJson: project.bundleJson,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    isActive: project.isActive
  });
}

function parseCompletedStepIdsFromPrisma(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseBlueprintSummary(rawBlueprint: string): {
  name: string;
  description: string;
  language: string;
} {
  try {
    const blueprint = ProjectBlueprintSchema.parse(JSON.parse(rawBlueprint));
    return {
      name: blueprint.name,
      description: blueprint.description,
      language: blueprint.language
    };
  } catch {
    return {
      name: "Project",
      description: "Agent-generated project",
      language: "Unknown"
    };
  }
}

function parseCurrentStepSummary(
  rawBlueprint: string,
  rawPlan: string
): {
  id: string | null;
  title: string | null;
  index: number | null;
  totalSteps: number;
} {
  try {
    const blueprint = ProjectBlueprintSchema.parse(JSON.parse(rawBlueprint));
    const plan = GeneratedProjectPlanSchema.parse(JSON.parse(rawPlan));
    const step =
      blueprint.steps.find((entry) => entry.id === plan.suggestedFirstStepId) ??
      blueprint.steps[0] ??
      null;

    if (!step) {
      return {
        id: null,
        title: null,
        index: null,
        totalSteps: 0
      };
    }

    return {
      id: step.id,
      title: step.title,
      index: Math.max(
        0,
        blueprint.steps.findIndex((entry) => entry.id === step.id)
      ),
      totalSteps: blueprint.steps.length
    };
  } catch {
    return {
      id: null,
      title: null,
      index: null,
      totalSteps: 0
    };
  }
}

function toStateKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function getCurrentUserId(): string {
  return process.env.CONSTRUCT_USER_ID?.trim() || "local-user";
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
