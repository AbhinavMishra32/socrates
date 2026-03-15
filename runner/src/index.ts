import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_NAME,
  AgentJobSnapshotSchema,
  BlueprintTaskRequestSchema,
  PlanningSessionCompleteRequestSchema,
  PlanningSessionStartRequestSchema,
  RuntimeGuideRequestSchema,
  TaskStartRequestSchema,
  TaskSubmitRequestSchema
} from "@construct/shared";

import { ConstructAgentService } from "./agentService";
import { AgentPlannerService } from "./agentPlanner";
import { WorkspaceFileManager } from "./fileManager";
import { SnapshotService } from "./snapshots";
import { TaskLifecycleService } from "./taskLifecycle";
import {
  BlueprintResolutionError,
  TestRunnerManager,
  loadBlueprint
} from "./testRunner";
import { prepareLearnerWorkspace } from "./workspaceMaterializer";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadRunnerEnvironment(rootDir);

const port = Number(process.env.CONSTRUCT_RUNNER_PORT ?? 43110);
const testRunner = new TestRunnerManager();
const canonicalBlueprintPath = path.join(
  rootDir,
  "blueprints",
  "workflow-runtime",
  "project-blueprint.json"
);
const preparedWorkspace = await prepareLearnerWorkspace(canonicalBlueprintPath);
const learnerBlueprintPath = preparedWorkspace.learnerBlueprintPath;
const workspaceRoot = preparedWorkspace.learnerWorkspaceRoot;
const workspaceFileManager = new WorkspaceFileManager(workspaceRoot, {
  ignoredDirectories: ["test-fixtures", "tests", "__tests__"],
  ignoredFiles: ["project-blueprint.json"]
});
const snapshotService = new SnapshotService(workspaceRoot);
const agentPlanner = new AgentPlannerService(rootDir);
const taskLifecycle = new TaskLifecycleService(workspaceRoot, {
  snapshotService,
  testRunner
});
let constructAgent: ConstructAgentService | null = null;

function getConstructAgent(): ConstructAgentService {
  if (!constructAgent) {
    constructAgent = new ConstructAgentService(rootDir);
  }

  return constructAgent;
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ready",
          service: `${APP_NAME} Runner`,
          port
        })
      );
      return;
    }

    if (request.method === "GET" && request.url === "/agent/planning/current") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(await agentPlanner.getCurrentPlanningState()));
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/agent/jobs/")) {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathParts = url.pathname.split("/").filter(Boolean);
      const [, , jobId, action] = pathParts;

      if (!jobId) {
        throw new Error("Missing agent job id.");
      }

      if (action === "stream") {
        getConstructAgent().openJobStream(jobId, response);
        return;
      }

      const job = AgentJobSnapshotSchema.parse(getConstructAgent().getJob(jobId));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(job));
      return;
    }

    if (request.method === "GET" && request.url === "/blueprint/current") {
      const blueprint = await loadBlueprint(learnerBlueprintPath);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          blueprint,
          workspaceRoot,
          blueprintPath: learnerBlueprintPath
        })
      );
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/workspace/files")) {
      const files = await workspaceFileManager.listFiles();

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          root: workspaceRoot,
          files
        })
      );
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/workspace/file")) {
      const relativePath = getRequiredQueryParam(request.url, "path");
      const content = await workspaceFileManager.readFile(relativePath);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          path: relativePath,
          content
        })
      );
      return;
    }

    if (request.method === "POST" && request.url === "/agent/planning/start") {
      const body = await readRequestBody(request);
      const startRequest = PlanningSessionStartRequestSchema.parse(JSON.parse(body));
      const planningSession = await agentPlanner.startPlanningSession(startRequest);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(planningSession));
      return;
    }

    if (request.method === "POST" && request.url === "/agent/planning/complete") {
      const body = await readRequestBody(request);
      const completeRequest = PlanningSessionCompleteRequestSchema.parse(JSON.parse(body));
      const planningResult = await agentPlanner.completePlanningSession(completeRequest);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(planningResult));
      return;
    }

    if (request.method === "POST" && request.url === "/agent/planning/start-job") {
      const body = await readRequestBody(request);
      const startRequest = PlanningSessionStartRequestSchema.parse(JSON.parse(body));
      const job = getConstructAgent().createPlanningQuestionsJob(startRequest);

      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify(job));
      return;
    }

    if (request.method === "POST" && request.url === "/agent/planning/complete-job") {
      const body = await readRequestBody(request);
      const completeRequest = PlanningSessionCompleteRequestSchema.parse(JSON.parse(body));
      const job = getConstructAgent().createPlanningPlanJob(completeRequest);

      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify(job));
      return;
    }

    if (request.method === "POST" && request.url === "/agent/runtime/guide-job") {
      const body = await readRequestBody(request);
      const guideRequest = RuntimeGuideRequestSchema.parse(JSON.parse(body));
      const job = getConstructAgent().createRuntimeGuideJob(guideRequest);

      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify(job));
      return;
    }

    if (request.method === "POST" && request.url === "/workspace/file") {
      const body = JSON.parse(await readRequestBody(request)) as {
        path?: string;
        content?: string;
      };

      if (typeof body.path !== "string" || typeof body.content !== "string") {
        throw new Error("A workspace path and string content are required.");
      }

      await workspaceFileManager.writeFile(body.path, body.content);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          path: body.path
        })
      );
      return;
    }

    if (request.method === "POST" && request.url === "/tasks/execute") {
      const body = await readRequestBody(request);
      const executionRequest = BlueprintTaskRequestSchema.parse(JSON.parse(body));
      const taskResult = await testRunner.runBlueprintStep(executionRequest);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(taskResult));
      return;
    }

    if (request.method === "POST" && request.url === "/tasks/start") {
      const body = await readRequestBody(request);
      const startRequest = TaskStartRequestSchema.parse(JSON.parse(body));
      const taskSession = await taskLifecycle.startTask(startRequest);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(taskSession));
      return;
    }

    if (request.method === "POST" && request.url === "/tasks/submit") {
      const body = await readRequestBody(request);
      const submitRequest = TaskSubmitRequestSchema.parse(JSON.parse(body));
      const taskSubmission = await taskLifecycle.submitTask(submitRequest);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(taskSubmission));
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/tasks/progress")) {
      const stepId = getRequiredQueryParam(request.url, "stepId");
      const progress = await taskLifecycle.getTaskProgress(stepId, learnerBlueprintPath);

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(progress));
      return;
    }

    if (request.method === "GET" && request.url === "/learner/model") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(await taskLifecycle.getLearnerModel()));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  } catch (error) {
    console.error(
      `[construct-runner] ${request.method ?? "UNKNOWN"} ${request.url ?? "<unknown>"}`,
      error
    );

    const statusCode =
      error instanceof SyntaxError ||
      error instanceof BlueprintResolutionError ||
      (error instanceof Error && error.name === "ZodError")
        ? 400
        : 500;

    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unexpected runner error."
      })
    );
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`${APP_NAME} runner listening on http://127.0.0.1:${port}`);
});

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function getRequiredQueryParam(requestUrl: string, key: string): string {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const value = url.searchParams.get(key);

  if (!value) {
    throw new Error(`Missing query parameter: ${key}.`);
  }

  return value;
}

function loadRunnerEnvironment(projectRoot: string): void {
  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  for (const fileName of [".env", ".env.local"]) {
    const envPath = path.join(projectRoot, fileName);

    try {
      process.loadEnvFile(envPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        console.warn(`[construct-runner] Failed to load ${fileName}`, error);
      }
    }
  }
}
