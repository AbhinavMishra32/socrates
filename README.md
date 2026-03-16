# Construct

Construct is an AI teaching IDE for learning software by building real projects.

You give it a goal like:

- build a C compiler in Rust
- create a Python todo CLI from scratch
- learn how module bundlers work by building one in TypeScript

Construct then turns that goal into a personalized course, workspace, and guided build path.

Instead of handing you a finished codebase or a generic tutorial, it helps you learn the concepts, answer checks, write the code yourself, and get guided when you get stuck.

We’re currently in development and getting ready for an initial `0.1` launch soon.

## Why Construct exists

Most coding tools do one of two things:

- teach concepts in isolation
- generate code without helping you truly understand it

Construct is built around a different idea:

the best way to learn software is to build something real, with teaching that adapts to what you already know and what you still need to understand.

That means Construct is trying to feel less like a code generator and more like a personalized technical mentor inside a real IDE.

## What Construct does

Construct takes a project goal and generates a complete learning environment around it:

- a personalized project path
- docs-style lessons written in markdown
- concept checks before implementation
- learner-owned exercises inside a real workspace
- hidden tests that validate the work
- an in-editor tutor that can help during the build
- a persistent knowledge base that tracks what the learner knows over time

The result is a project that teaches, not just a project that exists.

## What makes it different

Construct is opinionated about learning:

- you should write the code
- the lessons should explain concepts before asking you to implement them
- the project should adapt to your current knowledge
- the system should remember what you know across projects
- struggling should change the teaching path, not just fail a task

This is the core loop Construct is designed around:

`goal -> tailoring -> lesson -> check -> exercise -> feedback -> deeper teaching when needed`

## How the product works

When a learner starts a new project, Construct:

1. asks a few tailoring questions  
   to understand background, preferences, and likely gaps

2. updates the learner knowledge base  
   as a recursive graph of concepts and sub-concepts

3. generates a bespoke project  
   including lessons, exercises, hidden tests, and project structure

4. opens the learner into a real IDE  
   with lessons, code, validations, and tutor support in one place

5. updates the teaching path over time  
   using quiz results, code attempts, hints, and runtime guidance

## Knowledge base

One of the main ideas behind Construct is that learner state should be concept-based, not just “beginner / intermediate / advanced”.

Construct stores a recursive knowledge graph made of topics and subtopics, for example:

- `rust`
- `rust.ownership`
- `rust.ownership.borrow-checker`
- `compiler-design.lexing`
- `compiler-design.lexing.nfa-dfa`
- `typescript.interfaces`
- `typescript.interfaces.mapped-types`

Each concept can accumulate evidence from:

- intake answers
- agent inference during planning
- quiz performance
- code submission outcomes
- runtime tutoring interactions

This is what makes personalization possible across projects, not just inside a single session.

## Project structure

- [`/Users/abhinavmishra/solin/socrates/app`](/Users/abhinavmishra/solin/socrates/app)  
  Electron desktop app, Monaco workspace, lesson UI, project dashboard, and tutor surfaces.

- [`/Users/abhinavmishra/solin/socrates/runner`](/Users/abhinavmishra/solin/socrates/runner)  
  Local runner, agent orchestration, project generation, task lifecycle, workspace materialization, and hidden test execution.

- [`/Users/abhinavmishra/solin/socrates/pkg/shared`](/Users/abhinavmishra/solin/socrates/pkg/shared)  
  Shared schemas and contracts used by the app and runner.

- [`/Users/abhinavmishra/solin/socrates/prisma`](/Users/abhinavmishra/solin/socrates/prisma)  
  Prisma schema for persisted user, project, and agent state.

- [`/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md`](/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md)  
  Ongoing engineering ledger for completed and pending work.

## Current state

Construct already includes the core product loop:

- project tailoring
- learner knowledge storage
- agent-generated project plans
- generated project blueprints
- docs-style lesson authoring
- hidden test validation
- runtime tutor flows
- desktop IDE experience
- persisted projects and learner state via Prisma

It is still an active work in progress, but the main system is already real and usable for development and experimentation.

## Running locally

### Requirements

- Node.js 25+
- pnpm 10+
- PostgreSQL if using Prisma persistence
- OpenAI and Tavily API keys for live agent generation

### Install

```bash
pnpm install
pnpm prisma:generate
```

### Environment

Copy values from [`/Users/abhinavmishra/solin/socrates/.env.example`](/Users/abhinavmishra/solin/socrates/.env.example) into your local `.env`.

Typical local setup:

```bash
CONSTRUCT_STORAGE_BACKEND=prisma
DATABASE_URL=...
DIRECT_URL=...
OPENAI_API_KEY=...
TAVILY_API_KEY=...
```

If you want to initialize the database:

```bash
pnpm prisma:push
pnpm db:bootstrap
```

### Start the app

```bash
pnpm dev
```

This runs the Electron app and the local runner together.

## Useful commands

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm test
pnpm prisma:generate
pnpm prisma:push
pnpm db:bootstrap
```

Verification scripts:

```bash
pnpm verify:phase1
pnpm verify:phase2
pnpm verify:phase3
pnpm verify:phase4
pnpm verify:phase5
```

## For contributors

If you want the lower-level engineering picture, the most useful places to start are:

- [`/Users/abhinavmishra/solin/socrates/runner/src/agentService.ts`](/Users/abhinavmishra/solin/socrates/runner/src/agentService.ts)
- [`/Users/abhinavmishra/solin/socrates/runner/src/knowledgeGraph.ts`](/Users/abhinavmishra/solin/socrates/runner/src/knowledgeGraph.ts)
- [`/Users/abhinavmishra/solin/socrates/app/src/renderer/App.tsx`](/Users/abhinavmishra/solin/socrates/app/src/renderer/App.tsx)
- [`/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md`](/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md)

## License

License information has not been finalized yet.
