require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── LLM helper with retry + repair ───────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const msg = await client.messages.create({
        model: 'claude-opus-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });
      const text = msg.content[0].text.trim();
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(clean);
      return { data: parsed, retried: attempt > 0 };
    } catch (err) {
      if (attempt === retries) throw new Error(`Stage failed after ${retries + 1} attempts: ${err.message}`);
      // repair prompt: ask it to fix JSON
      userMessage = userMessage + '\n\nYour previous response had invalid JSON. Return ONLY valid JSON, no markdown, no explanation.';
    }
  }
}

// ─── STAGE PROMPTS ─────────────────────────────────────────────────────────────
const STAGE1_SYSTEM = `You are a requirements analyst for software generation. Extract structured intent from natural language app prompts.
Output ONLY valid raw JSON (no markdown, no code fences) matching this schema:
{
  "app_type": "string (e.g. CRM, SaaS, marketplace)",
  "app_name": "string (short inferred name)",
  "core_features": ["string"],
  "user_roles": ["string"],
  "auth_required": boolean,
  "payments_required": boolean,
  "analytics_required": boolean,
  "real_time_required": boolean,
  "ambiguities": ["string - anything unclear in the prompt"],
  "assumptions": ["string - reasonable assumptions made for unclear parts"]
}
If the prompt is vague, make reasonable assumptions and document them in assumptions[].`;

const STAGE2_SYSTEM = `You are a software architect. Convert an intent object into a full system design.
Output ONLY valid raw JSON (no markdown):
{
  "entities": [{"name":"string","description":"string","fields":["string"],"relations":["string"]}],
  "pages": [{"name":"string","type":"list|form|dashboard|detail|auth","access_roles":["string"],"description":"string"}],
  "flows": [{"name":"string","trigger":"string","steps":["string"]}],
  "integrations": ["string (e.g. Stripe, SendGrid)"],
  "architecture_notes": "string"
}`;

const STAGE3_UI_SYSTEM = `You are a UI schema generator for a web app builder.
Output ONLY valid raw JSON (no markdown):
{
  "pages": [
    {
      "name": "string",
      "route": "string (e.g. /dashboard)",
      "layout": "sidebar|fullwidth|centered",
      "access_roles": ["string"],
      "components": [
        {
          "type": "table|form|chart|card|navbar|sidebar|button|modal",
          "id": "string",
          "label": "string",
          "data_source": "string (API endpoint this maps to)",
          "props": {}
        }
      ]
    }
  ]
}`;

const STAGE3_API_SYSTEM = `You are a REST API schema generator.
Output ONLY valid raw JSON (no markdown):
{
  "base_path": "/api/v1",
  "endpoints": [
    {
      "method": "GET|POST|PUT|DELETE|PATCH",
      "path": "string (e.g. /users/:id)",
      "description": "string",
      "auth_required": boolean,
      "roles": ["string"],
      "request_body": {
        "fields": [{"name":"string","type":"string","required":boolean}]
      },
      "response": {
        "status": 200,
        "fields": [{"name":"string","type":"string"}]
      }
    }
  ]
}`;

const STAGE3_DB_SYSTEM = `You are a database schema designer (PostgreSQL/MySQL).
Output ONLY valid raw JSON (no markdown):
{
  "dialect": "postgresql",
  "tables": [
    {
      "name": "string",
      "columns": [
        {"name":"string","type":"string","nullable":boolean,"primary_key":boolean,"unique":boolean,"foreign_key":"tablename.column or null","default":"string or null"}
      ],
      "indexes": ["string (e.g. idx_users_email on email)"]
    }
  ]
}`;

const STAGE3_AUTH_SYSTEM = `You are an authentication and authorization designer.
Output ONLY valid raw JSON (no markdown):
{
  "auth_method": "JWT|session|oauth",
  "token_expiry": "string (e.g. 7d)",
  "roles": [
    {
      "name": "string",
      "description": "string",
      "permissions": ["string (e.g. contacts:read, analytics:view)"]
    }
  ],
  "session_strategy": "string",
  "password_policy": {"min_length":8,"require_uppercase":boolean,"require_number":boolean},
  "oauth_providers": ["string"],
  "mfa_required": boolean
}`;

const STAGE4_VALIDATION_SYSTEM = `You are a schema consistency validator. Check cross-layer consistency between UI, API, DB and Auth schemas.
Output ONLY valid raw JSON (no markdown):
{
  "issues": [
    {
      "layer": "string (e.g. UI->API, API->DB, AUTH->UI)",
      "field": "string (specific field or endpoint name)",
      "severity": "error|warn|fixed",
      "message": "string",
      "repaired": boolean,
      "repair_action": "string or null"
    }
  ],
  "assumptions": ["string"],
  "consistency_score": number_0_to_100,
  "summary": "string"
}
Checks: (1) Every UI data_source maps to a real API endpoint. (2) Every API endpoint references valid DB tables. (3) All roles in UI access_roles exist in Auth roles. (4) All DB foreign_key references point to real tables. (5) No API endpoint writes to a non-existent table. Mark issues as repaired:true if you auto-fixed them.`;

const STAGE5_EXEC_SYSTEM = `You are an execution readiness validator for generated app schemas. You verify the output is directly usable to generate a working application.
Output ONLY valid raw JSON (no markdown):
{
  "score": number_0_to_100,
  "grade": "A|B|C|D|F",
  "checks": [
    {"name":"string","pass":boolean,"detail":"string","critical":boolean}
  ],
  "runtime_targets": ["string (e.g. Next.js, Express+React, Django)"],
  "estimated_files": number,
  "blockers": ["string - things that would prevent code generation"],
  "summary": "string"
}
Check: (1) All pages have routes, (2) All DB tables have primary keys, (3) All API endpoints have auth defined, (4) All UI components have data_source, (5) All roles have permissions, (6) No circular FK dependencies, (7) Auth method is specified, (8) At least one admin role exists.`;

// ─── VALIDATION + REPAIR logic ─────────────────────────────────────────────────
function validateCrossLayer(ui, api, db, auth) {
  const issues = [];

  // Check: UI data_sources → API endpoints
  const apiPaths = new Set((api.endpoints || []).map(e => e.path));
  (ui.pages || []).forEach(page => {
    (page.components || []).forEach(comp => {
      if (comp.data_source && !apiPaths.has(comp.data_source)) {
        issues.push({
          layer: 'UI->API',
          field: comp.data_source,
          severity: 'warn',
          message: `UI component "${comp.id}" references data_source "${comp.data_source}" which has no matching API endpoint`,
          repaired: false
        });
      }
    });
  });

  // Check: All DB tables have PKs
  (db.tables || []).forEach(table => {
    const hasPK = (table.columns || []).some(c => c.primary_key);
    if (!hasPK) {
      issues.push({
        layer: 'DB',
        field: table.name,
        severity: 'fixed',
        message: `Table "${table.name}" has no primary key — auto-adding id SERIAL PRIMARY KEY`,
        repaired: true,
        repair_action: 'Added id SERIAL PRIMARY KEY column'
      });
      table.columns.unshift({ name: 'id', type: 'SERIAL', nullable: false, primary_key: true, unique: true, foreign_key: null, default: null });
    }
  });

  // Check: Roles in UI match Auth roles
  const authRoleNames = new Set((auth.roles || []).map(r => r.name.toLowerCase()));
  (ui.pages || []).forEach(page => {
    (page.access_roles || []).forEach(role => {
      if (!authRoleNames.has(role.toLowerCase())) {
        issues.push({
          layer: 'AUTH->UI',
          field: role,
          severity: 'warn',
          message: `Role "${role}" used in page "${page.name}" is not defined in Auth roles`,
          repaired: false
        });
      }
    });
  });

  return issues;
}

// ─── MAIN PIPELINE ENDPOINT ────────────────────────────────────────────────────
app.post('/api/compile', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });

  const pipeline = { stages: [], metrics: {} };
  const start = Date.now();
  let totalRetries = 0;

  try {
    // ── STAGE 1: Intent Extraction ──────────────────────────────────────────
    const t1 = Date.now();
    const s1 = await callClaude(STAGE1_SYSTEM, `Extract intent from this prompt: "${prompt}"`);
    if (s1.retried) totalRetries++;
    pipeline.intent = s1.data;
    pipeline.stages.push({ id: 1, name: 'Intent Extraction', status: 'done', ms: Date.now() - t1, retried: s1.retried });

    // ── STAGE 2: System Design ──────────────────────────────────────────────
    const t2 = Date.now();
    const s2 = await callClaude(STAGE2_SYSTEM, `Design the system for: ${JSON.stringify(s1.data)}`);
    if (s2.retried) totalRetries++;
    pipeline.design = s2.data;
    pipeline.stages.push({ id: 2, name: 'System Design', status: 'done', ms: Date.now() - t2, retried: s2.retried });

    // ── STAGE 3: Schema Generation (4 sub-schemas) ──────────────────────────
    const t3 = Date.now();
    const [sUI, sAPI, sDB, sAUTH] = await Promise.all([
      callClaude(STAGE3_UI_SYSTEM, `Generate UI schema for: ${JSON.stringify(s2.data)}`),
      callClaude(STAGE3_API_SYSTEM, `Generate API schema for entities: ${JSON.stringify(s2.data.entities)}`),
      callClaude(STAGE3_DB_SYSTEM, `Generate DB schema for entities: ${JSON.stringify(s2.data.entities)}`),
      callClaude(STAGE3_AUTH_SYSTEM, `Design auth for roles: ${JSON.stringify(s1.data.user_roles)}, features: ${JSON.stringify(s1.data.core_features)}`)
    ]);
    [sUI, sAPI, sDB, sAUTH].forEach(s => { if (s.retried) totalRetries++; });
    pipeline.ui = sUI.data;
    pipeline.api = sAPI.data;
    pipeline.db = sDB.data;
    pipeline.auth = sAUTH.data;
    pipeline.stages.push({ id: 3, name: 'Schema Generation', status: 'done', ms: Date.now() - t3, sub_stages: 4 });

    // ── STAGE 4: Validation + Repair ────────────────────────────────────────
    const t4 = Date.now();
    // First: deterministic local checks
    const localIssues = validateCrossLayer(pipeline.ui, pipeline.api, pipeline.db, pipeline.auth);
    // Then: LLM semantic validation
    const s4 = await callClaude(
      STAGE4_VALIDATION_SYSTEM,
      `Validate these schemas:\nUI: ${JSON.stringify(pipeline.ui)}\nAPI: ${JSON.stringify(pipeline.api)}\nDB: ${JSON.stringify(pipeline.db)}\nAUTH: ${JSON.stringify(pipeline.auth)}`
    );
    if (s4.retried) totalRetries++;
    // Merge issues
    s4.data.issues = [...localIssues, ...(s4.data.issues || [])];
    pipeline.validation = s4.data;
    pipeline.stages.push({ id: 4, name: 'Validation + Repair', status: 'done', ms: Date.now() - t4, issues_found: s4.data.issues.length, retried: s4.retried });

    // ── STAGE 5: Execution Check ─────────────────────────────────────────────
    const t5 = Date.now();
    const s5 = await callClaude(
      STAGE5_EXEC_SYSTEM,
      `Check execution readiness:\nPages: ${JSON.stringify(pipeline.ui?.pages?.map(p => p.name))}\nEndpoints: ${JSON.stringify(pipeline.api?.endpoints?.map(e => e.method + ' ' + e.path))}\nTables: ${JSON.stringify(pipeline.db?.tables?.map(t => t.name))}\nRoles: ${JSON.stringify(pipeline.auth?.roles?.map(r => r.name))}`
    );
    if (s5.retried) totalRetries++;
    pipeline.exec = s5.data;
    pipeline.stages.push({ id: 5, name: 'Execution Check', status: 'done', ms: Date.now() - t5, score: s5.data.score });

    // ── METRICS ──────────────────────────────────────────────────────────────
    pipeline.metrics = {
      total_ms: Date.now() - start,
      total_retries: totalRetries,
      issues_fixed: (pipeline.validation.issues || []).filter(i => i.repaired).length,
      exec_score: pipeline.exec.score,
      llm_calls: 7,
      tables: pipeline.db?.tables?.length || 0,
      endpoints: pipeline.api?.endpoints?.length || 0,
      pages: pipeline.ui?.pages?.length || 0
    };

    res.json({ success: true, pipeline });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stages_completed: pipeline.stages.length });
  }
});

// Serve frontend for all other routes
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AppCompiler running on http://localhost:${PORT}`));
