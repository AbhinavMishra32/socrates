import type http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  AgentEventSchema,
  AgentJobCreatedResponseSchema,
  AgentJobSnapshotSchema,
  CurrentPlanningSessionResponseSchema,
  GeneratedProjectPlanSchema,
  KnowledgeGraphSchema,
  PlanningQuestionSchema,
  PlanningSessionCompleteRequestSchema,
  PlanningSessionCompleteResponseSchema,
  PlanningSessionSchema,
  PlanningSessionStartRequestSchema,
  PlanningSessionStartResponseSchema,
  RuntimeGuideRequestSchema,
  RuntimeGuideResponseSchema,
  UserKnowledgeBaseSchema,
  type AgentEvent,
  type AgentJobCreatedResponse,
  type AgentJobKind,
  type AgentJobSnapshot,
  type ArchitectureComponent,
  type ConceptConfidence,
  type GeneratedProjectPlan,
  type KnowledgeGraph,
  type LearningStyle,
  type PlanningQuestion,
  type PlanningSession,
  type PlanningSessionCompleteRequest,
  type PlanningSessionCompleteResponse,
  type PlanningSessionStartRequest,
  type PlanningSessionStartResponse,
  type RuntimeGuideRequest,
  type RuntimeGuideResponse,
  type UserKnowledgeBase
} from "@construct/shared";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { tavily } from "@tavily/core";
import { z } from "zod";

type PlanningStateFile = {
  session: PlanningSession | null;
  plan: GeneratedProjectPlan | null;
};

type JobListener = (eventName: string, payload: unknown) => void;

type AgentJobRecord = {
  jobId: string;
  kind: AgentJobKind;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  events: AgentEvent[];
  result: unknown | null;
  error?: string;
  listeners: Set<JobListener>;
};

type ResearchSource = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
};

type ResearchDigest = {
  query: string;
  answer?: string;
  sources: ResearchSource[];
};

type AgentConfig = {
  provider: "openai";
  searchProvider: "tavily" | "exa";
  openAiModel: string;
  openAiApiKey: string;
  openAiBaseUrl?: string;
  tavilyApiKey: string;
  tavilySearchDepth: "basic" | "advanced" | "fast" | "ultra-fast";
};

type AgentDependencies = {
  now?: () => Date;
  llm?: StructuredLanguageModel;
  search?: SearchProvider;
};

type StructuredLanguageModel = {
  parse<T extends z.ZodTypeAny>(input: {
    schema: T;
    schemaName: string;
    instructions: string;
    prompt: string;
  }): Promise<z.infer<T>>;
};

type SearchProvider = {
  research(query: string): Promise<ResearchDigest>;
};

type QuestionGraphState = {
  jobId: string;
  request: PlanningSessionStartRequest;
  knowledgeBase: UserKnowledgeBase;
  research: ResearchDigest | null;
  session: PlanningSession | null;
};

type PlanGraphState = {
  jobId: string;
  request: PlanningSessionCompleteRequest;
  session: PlanningSession;
  knowledgeBase: UserKnowledgeBase;
  research: ResearchDigest | null;
  plan: GeneratedProjectPlan | null;
};

type RuntimeGuideGraphState = {
  jobId: string;
  request: RuntimeGuideRequest;
  knowledgeBase: UserKnowledgeBase;
  guide: RuntimeGuideResponse | null;
};

const PLANNING_QUESTION_DRAFT_SCHEMA = z.object({
  detectedLanguage: z.string().min(1),
  detectedDomain: z.string().min(1),
  questions: z.array(
    z.object({
      conceptId: z.string().min(1),
      category: z.enum(["language", "domain", "workflow"]),
      prompt: z.string().min(1)
    })
  ).min(4).max(8)
});

const GENERATED_PROJECT_PLAN_DRAFT_SCHEMA = z.object({
  summary: z.string().min(1),
  knowledgeGraph: KnowledgeGraphSchema,
  architecture: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      kind: z.enum(["component", "skill"]),
      summary: z.string().min(1),
      dependsOn: z.array(z.string().min(1)).default([])
    })
  ).min(1),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      kind: z.enum(["skill", "implementation"]),
      objective: z.string().min(1),
      rationale: z.string().min(1),
      concepts: z.array(z.string().min(1)).default([]),
      dependsOn: z.array(z.string().min(1)).default([]),
      validationFocus: z.array(z.string().min(1)).default([]),
      suggestedFiles: z.array(z.string().min(1)).default([]),
      implementationNotes: z.array(z.string().min(1)).default([]),
      quizFocus: z.array(z.string().min(1)).default([]),
      hiddenValidationFocus: z.array(z.string().min(1)).default([])
    })
  ).min(1),
  suggestedFirstStepId: z.string().min(1)
});

const CONFIDENCE_OPTIONS = [
  {
    id: "comfortable",
    label: "Comfortable",
    description: "I can use this without much support.",
    value: "comfortable" as const
  },
  {
    id: "shaky",
    label: "Shaky",
    description: "I know the shape of it, but I still need help.",
    value: "shaky" as const
  },
  {
    id: "new",
    label: "New",
    description: "I would need this taught from first principles.",
    value: "new" as const
  }
] as const;

export class ConstructAgentService {
  private readonly statePath: string;
  private readonly knowledgeBasePath: string;
  private readonly generatedPlansDirectory: string;
  private readonly now: () => Date;
  private readonly llm: StructuredLanguageModel;
  private readonly search: SearchProvider;
  private readonly jobs = new Map<string, AgentJobRecord>();

  constructor(
    rootDirectory: string,
    dependencies: AgentDependencies = {}
  ) {
    this.statePath = path.join(rootDirectory, ".construct", "state", "agent-planner.json");
    this.knowledgeBasePath = path.join(
      rootDirectory,
      ".construct",
      "state",
      "user-knowledge.json"
    );
    this.generatedPlansDirectory = path.join(
      rootDirectory,
      ".construct",
      "generated-plans"
    );
    this.now = dependencies.now ?? (() => new Date());

    if (dependencies.llm) {
      this.llm = dependencies.llm;
    } else {
      const config = resolveAgentConfig();
      this.llm = new OpenAIStructuredLanguageModel({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.openAiModel
      });
    }

    if (dependencies.search) {
      this.search = dependencies.search;
    } else {
      const config = resolveAgentConfig();
      this.search = buildSearchProvider({
        provider: config.searchProvider,
        tavilyApiKey: config.tavilyApiKey,
        depth: config.tavilySearchDepth
      });
    }
  }

  async getCurrentPlanningState(): Promise<PlanningStateFile> {
    const state = await this.readPlanningState();
    return CurrentPlanningSessionResponseSchema.parse(state);
  }

  createPlanningQuestionsJob(
    input: PlanningSessionStartRequest
  ): AgentJobCreatedResponse {
    const request = PlanningSessionStartRequestSchema.parse(input);
    const job = this.createJob("planning-questions");

    void this.runJob(job, async () => {
      const result = await this.runPlanningQuestionGraph(job.jobId, request);
      return PlanningSessionStartResponseSchema.parse(result);
    });

    return AgentJobCreatedResponseSchema.parse({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      streamPath: `/agent/jobs/${job.jobId}/stream`,
      resultPath: `/agent/jobs/${job.jobId}`
    });
  }

  createPlanningPlanJob(
    input: PlanningSessionCompleteRequest
  ): AgentJobCreatedResponse {
    const request = PlanningSessionCompleteRequestSchema.parse(input);
    const job = this.createJob("planning-plan");

    void this.runJob(job, async () => {
      const result = await this.runPlanningPlanGraph(job.jobId, request);
      return PlanningSessionCompleteResponseSchema.parse(result);
    });

    return AgentJobCreatedResponseSchema.parse({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      streamPath: `/agent/jobs/${job.jobId}/stream`,
      resultPath: `/agent/jobs/${job.jobId}`
    });
  }

  createRuntimeGuideJob(input: RuntimeGuideRequest): AgentJobCreatedResponse {
    const request = RuntimeGuideRequestSchema.parse(input);
    const job = this.createJob("runtime-guide");

    void this.runJob(job, async () => {
      const result = await this.runRuntimeGuideGraph(job.jobId, request);
      return RuntimeGuideResponseSchema.parse(result);
    });

    return AgentJobCreatedResponseSchema.parse({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      streamPath: `/agent/jobs/${job.jobId}/stream`,
      resultPath: `/agent/jobs/${job.jobId}`
    });
  }

  getJob(jobId: string): AgentJobSnapshot {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Unknown agent job ${jobId}.`);
    }

    return AgentJobSnapshotSchema.parse({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error,
      result: job.result
    });
  }

  openJobStream(jobId: string, response: http.ServerResponse): void {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Unknown agent job ${jobId}.`);
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const send = (eventName: string, payload: unknown) => {
      response.write(`event: ${eventName}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send("agent-state", this.getJob(jobId));

    for (const event of job.events) {
      send("agent-event", event);
    }

    if (job.status === "completed") {
      send("agent-complete", {
        jobId,
        result: job.result
      });
      response.end();
      return;
    }

    if (job.status === "failed") {
      send("agent-error", {
        jobId,
        error: job.error ?? "Unknown agent failure."
      });
      response.end();
      return;
    }

    job.listeners.add(send);

    response.on("close", () => {
      job.listeners.delete(send);
    });
  }

  private createJob(kind: AgentJobKind): AgentJobRecord {
    const timestamp = this.now().toISOString();
    const record: AgentJobRecord = {
      jobId: randomUUID(),
      kind,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [],
      result: null,
      listeners: new Set()
    };

    this.jobs.set(record.jobId, record);
    return record;
  }

  private async runJob<T>(job: AgentJobRecord, task: () => Promise<T>): Promise<void> {
    this.updateJobStatus(job, "running");

    try {
      const result = await task();
      job.result = result;
      this.updateJobStatus(job, "completed");
      this.broadcast(job, "agent-complete", {
        jobId: job.jobId,
        result
      });
      this.closeListeners(job);
    } catch (error) {
      job.error = error instanceof Error ? error.message : "Unknown agent failure.";
      this.updateJobStatus(job, "failed");
      this.emitEvent(job, {
        stage: "failed",
        title: "Agent run failed",
        detail: job.error,
        level: "error"
      });
      this.broadcast(job, "agent-error", {
        jobId: job.jobId,
        error: job.error
      });
      this.closeListeners(job);
    }
  }

  private updateJobStatus(
    job: AgentJobRecord,
    status: AgentJobRecord["status"]
  ): void {
    job.status = status;
    job.updatedAt = this.now().toISOString();
    this.broadcast(job, "agent-state", this.getJob(job.jobId));
  }

  private closeListeners(job: AgentJobRecord): void {
    for (const listener of job.listeners) {
      listener("agent-end", {
        jobId: job.jobId,
        status: job.status
      });
    }

    job.listeners.clear();
  }

  private emitEvent(
    job: AgentJobRecord,
    input: Omit<AgentEvent, "id" | "jobId" | "kind" | "timestamp">
  ): void {
    const event = AgentEventSchema.parse({
      id: randomUUID(),
      jobId: job.jobId,
      kind: job.kind,
      timestamp: this.now().toISOString(),
      ...input
    });

    job.events.push(event);
    job.updatedAt = event.timestamp;
    this.broadcast(job, "agent-event", event);
  }

  private broadcast(job: AgentJobRecord, eventName: string, payload: unknown): void {
    for (const listener of job.listeners) {
      listener(eventName, payload);
    }
  }

  private async runPlanningQuestionGraph(
    jobId: string,
    request: PlanningSessionStartRequest
  ): Promise<PlanningSessionStartResponse> {
    const StateAnnotation = Annotation.Root({
      jobId: Annotation<string>(),
      request: Annotation<PlanningSessionStartRequest>(),
      knowledgeBase: Annotation<UserKnowledgeBase>(),
      research: Annotation<ResearchDigest | null>(),
      session: Annotation<PlanningSession | null>()
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("loadKnowledgeBase", async (state) => ({
        knowledgeBase: await this.withStage(jobId, "knowledge-base", "Loading learner knowledge", "Pulling stored concept history and past goals.", async () => {
          return this.readKnowledgeBase();
        })
      }))
      .addNode("researchGoal", async (state) => ({
        research: await this.withStage(jobId, "research", "Researching the target project", "Fetching architecture and implementation references from Tavily.", async () => {
          return this.search.research(
            `Project architecture, implementation order, and prerequisites for: ${state.request.goal}`
          );
        })
      }))
      .addNode("generateQuestions", async (state) => ({
        session: await this.withStage(jobId, "question-generation", "Generating targeted knowledge questions", "OpenAI is turning the goal and stored knowledge into concept-level intake questions.", async () => {
          const questionDraft = await this.llm.parse({
            schema: PLANNING_QUESTION_DRAFT_SCHEMA,
            schemaName: "construct_planning_question_draft",
            instructions: buildQuestionGenerationInstructions(),
            prompt: JSON.stringify(
              {
                goal: state.request.goal,
                learningStyle: state.request.learningStyle,
                priorKnowledge: state.knowledgeBase,
                research: state.research
              },
              null,
              2
            )
          });

          return this.buildPlanningSession(state.request, questionDraft);
        })
      }))
      .addEdge(START, "loadKnowledgeBase")
      .addEdge("loadKnowledgeBase", "researchGoal")
      .addEdge("researchGoal", "generateQuestions")
      .addEdge("generateQuestions", END)
      .compile();

    const result = await graph.invoke({
      jobId,
      request,
      knowledgeBase: emptyKnowledgeBase(this.now),
      research: null,
      session: null
    });

    await this.writePlanningState({
      session: result.session,
      plan: null
    });

    return PlanningSessionStartResponseSchema.parse({
      session: result.session
    });
  }

  private async runPlanningPlanGraph(
    jobId: string,
    request: PlanningSessionCompleteRequest
  ): Promise<PlanningSessionCompleteResponse> {
    const planningState = await this.readPlanningState();

    if (!planningState.session || planningState.session.sessionId !== request.sessionId) {
      throw new Error(`Unknown planning session ${request.sessionId}.`);
    }

    const session = planningState.session;

    const StateAnnotation = Annotation.Root({
      jobId: Annotation<string>(),
      request: Annotation<PlanningSessionCompleteRequest>(),
      session: Annotation<PlanningSession>(),
      knowledgeBase: Annotation<UserKnowledgeBase>(),
      research: Annotation<ResearchDigest | null>(),
      plan: Annotation<GeneratedProjectPlan | null>()
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("loadKnowledgeBase", async () => ({
        knowledgeBase: await this.withStage(jobId, "knowledge-base", "Loading learner knowledge", "Combining stored knowledge with the current self-reported answers.", async () => {
          return this.readKnowledgeBase();
        })
      }))
      .addNode("researchArchitecture", async (state) => ({
        research: await this.withStage(jobId, "research", "Researching architecture and build order", "Fetching reference material for the requested system shape and likely dependency order.", async () => {
          return this.search.research(
            `${state.session.goal} architecture, dependency order, core modules, implementation sequence`
          );
        })
      }))
      .addNode("generatePlan", async (state) => ({
        plan: await this.withStage(jobId, "plan-generation", "Synthesizing the personalized roadmap", "OpenAI is merging the project dependencies, learner profile, and research into a detailed build path.", async () => {
          const planDraft = await this.llm.parse({
            schema: GENERATED_PROJECT_PLAN_DRAFT_SCHEMA,
            schemaName: "construct_generated_project_plan",
            instructions: buildPlanGenerationInstructions(),
            prompt: JSON.stringify(
              {
                session: state.session,
                answers: state.request.answers,
                priorKnowledge: state.knowledgeBase,
                research: state.research
              },
              null,
              2
            )
          });

          const plan = this.buildGeneratedPlan(state.session, planDraft);
          await this.persistPlanningArtifacts(state.session, plan);
          await this.writePlanningState({
            session: state.session,
            plan
          });
          await this.mergeKnowledgeBase(state.knowledgeBase, state.session, plan);

          return plan;
        })
      }))
      .addEdge(START, "loadKnowledgeBase")
      .addEdge("loadKnowledgeBase", "researchArchitecture")
      .addEdge("researchArchitecture", "generatePlan")
      .addEdge("generatePlan", END)
      .compile();

    const result = await graph.invoke({
      jobId,
      request,
      session,
      knowledgeBase: emptyKnowledgeBase(this.now),
      research: null,
      plan: null
    });

    return PlanningSessionCompleteResponseSchema.parse({
      session,
      plan: result.plan
    });
  }

  private async runRuntimeGuideGraph(
    jobId: string,
    request: RuntimeGuideRequest
  ): Promise<RuntimeGuideResponse> {
    const StateAnnotation = Annotation.Root({
      jobId: Annotation<string>(),
      request: Annotation<RuntimeGuideRequest>(),
      knowledgeBase: Annotation<UserKnowledgeBase>(),
      guide: Annotation<RuntimeGuideResponse | null>()
    });

    const graph = new StateGraph(StateAnnotation)
      .addNode("loadKnowledgeBase", async () => ({
        knowledgeBase: await this.withStage(jobId, "knowledge-base", "Loading learner context", "Reading stored knowledge so guidance matches prior signals.", async () => {
          return this.readKnowledgeBase();
        })
      }))
      .addNode("generateGuidance", async (state) => ({
        guide: await this.withStage(jobId, "runtime-guide", "Analyzing the current implementation", "OpenAI is reviewing the anchored code, constraints, and latest test result to prepare Socratic guidance.", async () => {
          return this.llm.parse({
            schema: RuntimeGuideResponseSchema,
            schemaName: "construct_runtime_guide",
            instructions: buildRuntimeGuideInstructions(),
            prompt: JSON.stringify(
              {
                request: state.request,
                priorKnowledge: state.knowledgeBase
              },
              null,
              2
            )
          });
        })
      }))
      .addEdge(START, "loadKnowledgeBase")
      .addEdge("loadKnowledgeBase", "generateGuidance")
      .addEdge("generateGuidance", END)
      .compile();

    const result = await graph.invoke({
      jobId,
      request,
      knowledgeBase: emptyKnowledgeBase(this.now),
      guide: null
    });

    return RuntimeGuideResponseSchema.parse(result.guide);
  }

  private async withStage<T>(
    jobId: string,
    stage: string,
    title: string,
    detail: string,
    task: () => Promise<T>
  ): Promise<T> {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error(`Unknown agent job ${jobId}.`);
    }

    this.emitEvent(job, {
      stage,
      title,
      detail,
      level: "info"
    });

    const result = await task();

    if (stage === "research") {
      const research = result as ResearchDigest;
      this.emitEvent(job, {
        stage,
        title: "Research references loaded",
        detail: `Collected ${research.sources.length} sources through ${research.query}.`,
        level: "success",
        payload: {
          query: research.query,
          sources: research.sources
        }
      });
      return result;
    }

    this.emitEvent(job, {
      stage,
      title: `${title} complete`,
      detail,
      level: "success"
    });

    return result;
  }

  private buildPlanningSession(
    request: PlanningSessionStartRequest,
    questionDraft: z.infer<typeof PLANNING_QUESTION_DRAFT_SCHEMA>
  ): PlanningSession {
    const normalizedGoal = request.goal.trim().replace(/\s+/g, " ");

    const questions = questionDraft.questions.map((question) =>
      PlanningQuestionSchema.parse({
        id: `question.${slugify(question.conceptId)}`,
        conceptId: question.conceptId,
        category: question.category,
        prompt: question.prompt,
        options: CONFIDENCE_OPTIONS
      })
    );

    const session = PlanningSessionSchema.parse({
      sessionId: randomUUID(),
      goal: normalizedGoal,
      normalizedGoal,
      learningStyle: request.learningStyle,
      detectedLanguage: questionDraft.detectedLanguage,
      detectedDomain: questionDraft.detectedDomain,
      createdAt: this.now().toISOString(),
      questions
    });

    return session;
  }

  private buildGeneratedPlan(
    session: PlanningSession,
    draft: z.infer<typeof GENERATED_PROJECT_PLAN_DRAFT_SCHEMA>
  ): GeneratedProjectPlan {
    return GeneratedProjectPlanSchema.parse({
      sessionId: session.sessionId,
      goal: session.goal,
      language: session.detectedLanguage,
      domain: session.detectedDomain,
      learningStyle: session.learningStyle,
      summary: draft.summary,
      knowledgeGraph: draft.knowledgeGraph,
      architecture: draft.architecture,
      steps: draft.steps,
      suggestedFirstStepId: draft.suggestedFirstStepId
    });
  }

  private async persistPlanningArtifacts(
    session: PlanningSession,
    plan: GeneratedProjectPlan
  ): Promise<void> {
    await mkdir(this.generatedPlansDirectory, { recursive: true });
    const artifactPath = path.join(this.generatedPlansDirectory, `${session.sessionId}.json`);
    await writeFile(artifactPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  }

  private async readPlanningState(): Promise<PlanningStateFile> {
    if (!existsSync(this.statePath)) {
      return {
        session: null,
        plan: null
      };
    }

    const rawState = await readFile(this.statePath, "utf8");
    return CurrentPlanningSessionResponseSchema.parse(JSON.parse(rawState));
  }

  private async writePlanningState(state: PlanningStateFile): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private async readKnowledgeBase(): Promise<UserKnowledgeBase> {
    if (!existsSync(this.knowledgeBasePath)) {
      return emptyKnowledgeBase(this.now);
    }

    const rawState = await readFile(this.knowledgeBasePath, "utf8");
    return UserKnowledgeBaseSchema.parse(JSON.parse(rawState));
  }

  private async mergeKnowledgeBase(
    current: UserKnowledgeBase,
    session: PlanningSession,
    plan: GeneratedProjectPlan
  ): Promise<void> {
    const conceptMap = new Map(current.concepts.map((concept) => [concept.id, concept]));
    const timestamp = this.now().toISOString();

    for (const concept of plan.knowledgeGraph.concepts) {
      conceptMap.set(concept.id, {
        id: concept.id,
        label: concept.label,
        category: concept.category,
        confidence: concept.confidence,
        rationale: concept.rationale,
        source: "self-report",
        updatedAt: timestamp
      });
    }

    const goals = current.goals.filter((goal) => goal.goal !== session.goal);
    goals.unshift({
      goal: session.goal,
      language: session.detectedLanguage,
      domain: session.detectedDomain,
      lastPlannedAt: timestamp
    });

    const nextKnowledgeBase = UserKnowledgeBaseSchema.parse({
      updatedAt: timestamp,
      concepts: Array.from(conceptMap.values()),
      goals: goals.slice(0, 25)
    });

    await mkdir(path.dirname(this.knowledgeBasePath), { recursive: true });
    await writeFile(
      this.knowledgeBasePath,
      `${JSON.stringify(nextKnowledgeBase, null, 2)}\n`,
      "utf8"
    );
  }
}

class OpenAIStructuredLanguageModel implements StructuredLanguageModel {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(input: { apiKey: string; baseUrl?: string; model: string }) {
    this.client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: input.baseUrl
    });
    this.model = input.model;
  }

  async parse<T extends z.ZodTypeAny>(input: {
    schema: T;
    schemaName: string;
    instructions: string;
    prompt: string;
  }): Promise<z.infer<T>> {
    const response = await this.client.responses.parse({
      model: this.model,
      instructions: input.instructions,
      input: input.prompt,
      max_output_tokens: 4_000,
      reasoning: {
        effort: "medium",
        summary: "auto"
      },
      text: {
        format: zodTextFormat(input.schema, input.schemaName),
        verbosity: "high"
      }
    });

    if (!response.output_parsed) {
      throw new Error(`OpenAI returned no parsed output for ${input.schemaName}.`);
    }

    return input.schema.parse(response.output_parsed);
  }
}

class TavilySearchProvider implements SearchProvider {
  private readonly client;

  constructor(
    private readonly apiKey: string,
    private readonly depth: "basic" | "advanced" | "fast" | "ultra-fast"
  ) {
    this.client = tavily({
      apiKey: this.apiKey
    });
  }

  async research(query: string): Promise<ResearchDigest> {
    const response = await this.client.search(query, {
      searchDepth: this.depth,
      maxResults: 5,
      includeAnswer: "advanced",
      includeRawContent: false
    });

    return {
      query,
      answer: response.answer,
      sources: response.results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
        publishedDate: result.publishedDate
      }))
    };
  }
}

function buildSearchProvider(input: {
  provider: "tavily" | "exa";
  tavilyApiKey: string;
  depth: "basic" | "advanced" | "fast" | "ultra-fast";
}): SearchProvider {
  if (input.provider === "exa") {
    throw new Error("Search provider EXA is not implemented yet. Set CONSTRUCT_SEARCH_PROVIDER=tavily.");
  }

  return new TavilySearchProvider(input.tavilyApiKey, input.depth);
}

function resolveAgentConfig(): AgentConfig {
  const provider = (process.env.CONSTRUCT_AGENT_PROVIDER ?? "openai").trim().toLowerCase();
  const searchProvider = (process.env.CONSTRUCT_SEARCH_PROVIDER ?? "tavily")
    .trim()
    .toLowerCase();
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim();

  if (provider !== "openai") {
    throw new Error(
      `Unsupported agent provider "${provider}". Construct currently supports CONSTRUCT_AGENT_PROVIDER=openai.`
    );
  }

  if (searchProvider !== "tavily" && searchProvider !== "exa") {
    throw new Error(
      `Unsupported search provider "${searchProvider}". Use CONSTRUCT_SEARCH_PROVIDER=tavily or exa.`
    );
  }

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for the real Construct agent stack.");
  }

  if (!tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is required for Construct agent research.");
  }

  return {
    provider: "openai",
    searchProvider,
    openAiApiKey,
    openAiBaseUrl: process.env.CONSTRUCT_OPENAI_BASE_URL?.trim(),
    openAiModel: process.env.CONSTRUCT_OPENAI_MODEL?.trim() || "gpt-5-codex",
    tavilyApiKey,
    tavilySearchDepth:
      (process.env.CONSTRUCT_TAVILY_SEARCH_DEPTH?.trim() as
        | "basic"
        | "advanced"
        | "fast"
        | "ultra-fast"
        | undefined) ?? "advanced"
  };
}

function emptyKnowledgeBase(now: () => Date): UserKnowledgeBase {
  return UserKnowledgeBaseSchema.parse({
    updatedAt: now().toISOString(),
    concepts: [],
    goals: []
  });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildQuestionGenerationInstructions(): string {
  return [
    "You are Construct's Architect agent.",
    "Your job is to prepare the intake phase for a serious local AI developer IDE.",
    "Given a project goal, prior stored learner knowledge, and lightweight web research, generate 4 to 8 concept-level knowledge questions.",
    "Ask only the minimum questions needed to personalize the build path.",
    "Questions must be exact and technical, not generic confidence surveys.",
    "Detected language and domain must match the target project.",
    "Favor prerequisite concepts that affect implementation order.",
    "Do not ask about concepts that are already clearly comfortable in the prior knowledge base unless the new goal materially changes their meaning."
  ].join("\n");
}

function buildPlanGenerationInstructions(): string {
  return [
    "You are Construct's Architect agent.",
    "Generate a detailed personalized project roadmap for a serious learning-first IDE.",
    "The learner will build the real project in-place, so every step must contribute to the final system.",
    "Use the learner's answers and prior knowledge to change step order, not just explanations.",
    "Architecture components must reflect true dependency order.",
    "Each step must include concrete validation focus, implementation notes, quiz focus, and hidden validation focus.",
    "Prefer steps that unlock later modules and make the dependency chain explicit.",
    "If the learner is weak in a prerequisite concept, insert a skill step immediately before the implementation step that needs it.",
    "Do not produce toy exercises disconnected from the project.",
    "Suggested first step must reference one of the generated steps."
  ].join("\n");
}

function buildRuntimeGuideInstructions(): string {
  return [
    "You are Construct's runtime Guide agent, a calm senior engineer helping the learner implement real project code.",
    "Use Socratic guidance first.",
    "Never give a full runnable solution.",
    "Return exactly 1 to 3 Socratic questions.",
    "Hints must escalate from a light nudge to pseudocode to a concrete scaffold description without fully solving the task.",
    "Observations should reference the test result, constraints, or code snippet when possible.",
    "Next action must be a single practical move the learner can take immediately."
  ].join("\n");
}
