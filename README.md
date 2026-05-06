# AppCompiler — NL to App Schema Pipeline

> Natural Language → Structured Config → Validated → Executable App Schema

A multi-stage LLM pipeline that compiles natural language product descriptions into complete, validated, executable application schemas.

## Live Demo
🔗 [appcompiler.vercel.app](https://appcompiler.vercel.app)

## Architecture

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│                    5-STAGE PIPELINE                      │
│                                                          │
│  Stage 1: Intent Extraction                              │
│  ├─ Parse roles, features, ambiguities, assumptions      │
│  │                                                       │
│  Stage 2: System Design                                  │
│  ├─ Entities, pages, flows, integrations                 │
│  │                                                       │
│  Stage 3: Schema Generation (parallel)                   │
│  ├─ UI Schema   (pages, components, data_sources)        │
│  ├─ API Schema  (endpoints, auth, request/response)      │
│  ├─ DB Schema   (tables, columns, FK relations)          │
│  └─ Auth Schema (roles, permissions, JWT config)         │
│                                                          │
│  Stage 4: Validation + Repair                            │
│  ├─ Deterministic checks (local, no LLM)                 │
│  ├─ LLM semantic consistency check                       │
│  └─ Auto-repair: missing PKs, orphaned refs, etc.        │
│                                                          │
│  Stage 5: Execution Readiness Check                      │
│  └─ Score 0-100%, grade, blockers, runtime targets       │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Complete JSON Schema (UI + API + DB + Auth)
```

## Setup

```bash
git clone https://github.com/yourusername/app-compiler
cd app-compiler
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm start
# Open http://localhost:3000
```

## Deploy to Vercel

```bash
npm install -g vercel
vercel
# Set ANTHROPIC_API_KEY in Vercel environment variables
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| 5 separate LLM calls | Each stage has a focused, constrained prompt → higher reliability than 1 mega-prompt |
| Parallel Stage 3 | UI/API/DB/Auth schemas are independent → 4x faster |
| Deterministic + LLM validation | Local checks catch structural issues instantly; LLM catches semantic ones |
| Auto-repair vs full retry | Targeted repair (e.g., add PK) is cheaper and faster than full regeneration |
| JSON-only system prompts | Constrained output format reduces hallucination and parse failures |

## Tech Stack
- **Backend**: Node.js + Express
- **LLM**: Anthropic Claude (claude-haiku-4-5 for speed/cost)
- **Frontend**: Vanilla HTML/CSS/JS (zero dependencies)
- **Deploy**: Vercel

## Evaluation Metrics
The system tracks per-run:
- Total latency (ms)
- LLM call count
- Repair retries
- Issues auto-fixed
- Execution readiness score (0-100%)
