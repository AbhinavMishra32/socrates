# Construct

Construct is a local-first teaching IDE that turns a software project idea into a guided, personalized build path.

Instead of giving you a finished app or a static tutorial, Construct:

- asks a small set of tailoring questions
- builds a concept-level knowledge graph for the learner
- generates a bespoke project, lesson flow, quizzes, and hidden validations
- opens a real workspace where the learner writes the code
- updates guidance as the learner succeeds, struggles, or asks for help

The goal is simple: help someone actually learn by building the thing they asked for.

## What Construct does

Given a prompt like:

- `build a C compiler in Rust`
- `create a Python todo CLI from scratch`
- `teach me how to build a small TypeScript bundler`

Construct generates a personalized learning project around that goal.

That includes:

- a runnable project blueprint
- learner-owned files with masked task regions
- hidden tests used for validation
- docs-style lesson chapters written in markdown
- concept checks before implementation
- a live tutor that can guide the learner during the exercise
- a recursive knowledge base that tracks concepts and sub-concepts over time

Construct is designed to feel closer to a teaching environment than a code generator.

## How it works

At a high level, Construct runs in four stages:

1. Intake  
   The Architect asks a few questions to understand the learner, project scope, and preferred teaching style.

2. Planning  
   Construct builds a personalized roadmap, lesson sequence, and project structure.

3. Generation  
   It creates the canonical solution, learner workspace, hidden tests, and docs-style lessons.

4. Runtime guidance  
   While the learner works, Construct can review quiz answers, code submissions, and struggles to adapt the teaching path and update the learner knowledge graph.

## Repository structure

- [`/Users/abhinavmishra/solin/socrates/app`](/Users/abhinavmishra/solin/socrates/app)  
  Electron desktop app, preload layer, renderer, Monaco editor integration, lesson UI, and project dashboard.

- [`/Users/abhinavmishra/solin/socrates/runner`](/Users/abhinavmishra/solin/socrates/runner)  
  Local runner service, agent orchestration, knowledge graph logic, workspace materialization, task lifecycle, and test execution.

- [`/Users/abhinavmishra/solin/socrates/pkg/shared`](/Users/abhinavmishra/solin/socrates/pkg/shared)  
  Shared schemas, blueprint types, agent contracts, and validation utilities.

- [`/Users/abhinavmishra/solin/socrates/prisma`](/Users/abhinavmishra/solin/socrates/prisma)  
  Prisma schema for persisted learner, project, and agent state.

- [`/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md`](/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md)  
  Internal implementation ledger tracking completed and pending work.

## Current architecture

Construct currently includes:

- Electron desktop shell
- local runner API
- project blueprint generation
- docs-style lesson authoring
- hidden test execution
- snapshotting and task lifecycle management
- recursive learner knowledge graph
- Prisma-backed persistence for projects, planning state, and knowledge base

The product is still evolving, but the core loop is already in place:

`goal -> tailoring -> personalized project -> lesson -> quiz -> exercise -> runtime guidance`

## Development

### Requirements

- Node.js 25+
- pnpm 10+
- a PostgreSQL database if using Prisma persistence
- OpenAI and Tavily keys for the live Architect flow

### Install

```bash
pnpm install
pnpm prisma:generate
```

### Configure

Copy values from [`/Users/abhinavmishra/solin/socrates/.env.example`](/Users/abhinavmishra/solin/socrates/.env.example) into your local `.env`.

At minimum, local development usually needs:

```bash
CONSTRUCT_STORAGE_BACKEND=prisma
DATABASE_URL=...
DIRECT_URL=...
OPENAI_API_KEY=...
TAVILY_API_KEY=...
```

If you want the database schema bootstrapped locally:

```bash
pnpm prisma:push
pnpm db:bootstrap
```

### Run

```bash
pnpm dev
```

This starts the Electron app and the local runner together.

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

Project verification scripts are also available:

```bash
pnpm verify:phase1
pnpm verify:phase2
pnpm verify:phase3
pnpm verify:phase4
pnpm verify:phase5
```

## Persistence model

Construct stores:

- planning sessions
- learner knowledge graph
- generated blueprints
- project progress
- active project state

The intended long-term model is a learner profile that becomes more accurate over time, not just per-project state.

## Knowledge graph

The learner model is concept-based and recursive.

That means Construct can track things like:

- `rust`
- `rust.ownership`
- `rust.ownership.borrow-checker`
- `compiler-design.lexing.nfa-dfa`
- `typescript.interfaces.mapped-types`

Each node can accumulate evidence from:

- intake answers
- planning-time inference
- quiz performance
- code submission outcomes
- runtime guidance

This is what lets Construct personalize not just the initial plan, but the teaching depth during the project.

## Status

Construct is currently in active development, with a `0.1` release planned soon.

The current repository is usable for development and experimentation, but the teaching runtime, UI, and agent behavior are still being refined.

If you want a detailed engineering view of what is finished versus in flight, see the implementation ledger:

- [`/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md`](/Users/abhinavmishra/solin/socrates/docs/implementation-ledger.md)

## License

License information has not been finalized yet.
