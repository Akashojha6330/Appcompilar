require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── GEMINI SETUP ─────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
});

// ─── LLM HELPER ───────────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {

      const prompt = `
SYSTEM:
${systemPrompt}

USER:
${userMessage}
`;

      const result = await model.generateContent(prompt);

      const response = await result.response;

      const text = response.text().trim();

      const clean = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const parsed = JSON.parse(clean);

      return {
        data: parsed,
        retried: attempt > 0,
      };

    } catch (err) {

      if (attempt === retries) {
        throw new Error(
          `Stage failed after ${retries + 1} attempts: ${err.message}`
        );
      }

      userMessage =
        userMessage +
        '\n\nYour previous response had invalid JSON. Return ONLY valid JSON.';
    }
  }
}

// ─── STAGE PROMPTS ────────────────────────────────────────────────────────────
const STAGE1_SYSTEM = `You are a requirements analyst for software generation.

Extract structured intent from natural language app prompts.

Output ONLY valid raw JSON.

{
  "app_type": "string",
  "app_name": "string",
  "core_features": ["string"],
  "user_roles": ["string"],
  "auth_required": true,
  "payments_required": false,
  "analytics_required": false,
  "real_time_required": false,
  "ambiguities": ["string"],
  "assumptions": ["string"]
}`;

const STAGE2_SYSTEM = `You are a software architect.

Output ONLY valid raw JSON.

{
  "entities": [
    {
      "name":"string",
      "description":"string",
      "fields":["string"],
      "relations":["string"]
    }
  ],
  "pages": [
    {
      "name":"string",
      "type":"dashboard",
      "access_roles":["string"],
      "description":"string"
    }
  ],
  "flows": [
    {
      "name":"string",
      "trigger":"string",
      "steps":["string"]
    }
  ],
  "integrations": ["string"],
  "architecture_notes": "string"
}`;

const STAGE3_UI_SYSTEM = `Generate ONLY valid JSON UI schema.

{
  "pages": [
    {
      "name": "string",
      "route": "string",
      "layout": "sidebar",
      "access_roles": ["string"],
      "components": [
        {
          "type": "table",
          "id": "string",
          "label": "string",
          "data_source": "string",
          "props": {}
        }
      ]
    }
  ]
}`;

const STAGE3_API_SYSTEM = `Generate ONLY valid JSON API schema.

{
  "base_path": "/api/v1",
  "endpoints": [
    {
      "method": "GET",
      "path": "/users",
      "description": "string",
      "auth_required": true,
      "roles": ["string"],
      "request_body": {
        "fields": []
      },
      "response": {
        "status": 200,
        "fields": []
      }
    }
  ]
}`;

const STAGE3_DB_SYSTEM = `Generate ONLY valid JSON DB schema.

{
  "dialect": "postgresql",
  "tables": [
    {
      "name": "string",
      "columns": [
        {
          "name":"string",
          "type":"string",
          "nullable":false,
          "primary_key":false,
          "unique":false,
          "foreign_key":null,
          "default":null
        }
      ],
      "indexes": []
    }
  ]
}`;

const STAGE3_AUTH_SYSTEM = `Generate ONLY valid JSON auth schema.

{
  "auth_method": "JWT",
  "token_expiry": "7d",
  "roles": [
    {
      "name": "admin",
      "description": "string",
      "permissions": ["string"]
    }
  ],
  "session_strategy": "jwt",
  "password_policy": {
    "min_length": 8,
    "require_uppercase": true,
    "require_number": true
  },
  "oauth_providers": [],
  "mfa_required": false
}`;

const STAGE4_VALIDATION_SYSTEM = `Validate schemas.

Output ONLY valid JSON.

{
  "issues": [],
  "assumptions": [],
  "consistency_score": 90,
  "summary": "string"
}`;

const STAGE5_EXEC_SYSTEM = `Check execution readiness.

Output ONLY valid JSON.

{
  "score": 90,
  "grade": "A",
  "checks": [],
  "runtime_targets": [],
  "estimated_files": 20,
  "blockers": [],
  "summary": "string"
}`;

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function validateCrossLayer(ui, api, db, auth) {

  const issues = [];

  const apiPaths = new Set(
    (api.endpoints || []).map(e => e.path)
  );

  (ui.pages || []).forEach(page => {

    (page.components || []).forEach(comp => {

      if (comp.data_source && !apiPaths.has(comp.data_source)) {

        issues.push({
          layer: 'UI->API',
          field: comp.data_source,
          severity: 'warn',
          message: `Missing API endpoint for ${comp.data_source}`,
          repaired: false,
        });
      }
    });
  });

  (db.tables || []).forEach(table => {

    const hasPK = (table.columns || []).some(
      c => c.primary_key
    );

    if (!hasPK) {

      issues.push({
        layer: 'DB',
        field: table.name,
        severity: 'fixed',
        message: `Added primary key to ${table.name}`,
        repaired: true,
      });

      table.columns.unshift({
        name: 'id',
        type: 'SERIAL',
        nullable: false,
        primary_key: true,
        unique: true,
        foreign_key: null,
        default: null,
      });
    }
  });

  const authRoles = new Set(
    (auth.roles || []).map(r => r.name.toLowerCase())
  );

  (ui.pages || []).forEach(page => {

    (page.access_roles || []).forEach(role => {

      if (!authRoles.has(role.toLowerCase())) {

        issues.push({
          layer: 'AUTH->UI',
          field: role,
          severity: 'warn',
          message: `Undefined role ${role}`,
          repaired: false,
        });
      }
    });
  });

  return issues;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
app.post('/api/compile', async (req, res) => {

  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({
      error: 'Prompt is required',
    });
  }

  const pipeline = {
    stages: [],
    metrics: {},
  };

  const start = Date.now();

  let totalRetries = 0;

  try {

    // ── STAGE 1 ────────────────────────────────────────────────────────────
    const t1 = Date.now();

    const s1 = await callClaude(
      STAGE1_SYSTEM,
      `Extract intent from this prompt: "${prompt}"`
    );

    if (s1.retried) totalRetries++;

    pipeline.intent = s1.data;

    pipeline.stages.push({
      id: 1,
      name: 'Intent Extraction',
      status: 'done',
      ms: Date.now() - t1,
    });

    // ── STAGE 2 ────────────────────────────────────────────────────────────
    const t2 = Date.now();

    const s2 = await callClaude(
      STAGE2_SYSTEM,
      `Design system for: ${JSON.stringify(s1.data)}`
    );

    pipeline.design = s2.data;

    pipeline.stages.push({
      id: 2,
      name: 'System Design',
      status: 'done',
      ms: Date.now() - t2,
    });

    // ── STAGE 3 ────────────────────────────────────────────────────────────
    const t3 = Date.now();

    const [sUI, sAPI, sDB, sAUTH] = await Promise.all([

      callClaude(
        STAGE3_UI_SYSTEM,
        `Generate UI schema for ${JSON.stringify(s2.data)}`
      ),

      callClaude(
        STAGE3_API_SYSTEM,
        `Generate API schema for ${JSON.stringify(s2.data.entities)}`
      ),

      callClaude(
        STAGE3_DB_SYSTEM,
        `Generate DB schema for ${JSON.stringify(s2.data.entities)}`
      ),

      callClaude(
        STAGE3_AUTH_SYSTEM,
        `Generate auth schema`
      ),
    ]);

    pipeline.ui = sUI.data;
    pipeline.api = sAPI.data;
    pipeline.db = sDB.data;
    pipeline.auth = sAUTH.data;

    pipeline.stages.push({
      id: 3,
      name: 'Schema Generation',
      status: 'done',
      ms: Date.now() - t3,
    });

    // ── STAGE 4 ────────────────────────────────────────────────────────────
    const t4 = Date.now();

    const localIssues = validateCrossLayer(
      pipeline.ui,
      pipeline.api,
      pipeline.db,
      pipeline.auth
    );

    const s4 = await callClaude(
      STAGE4_VALIDATION_SYSTEM,
      `Validate schemas`
    );

    s4.data.issues = [
      ...localIssues,
      ...(s4.data.issues || []),
    ];

    pipeline.validation = s4.data;

    pipeline.stages.push({
      id: 4,
      name: 'Validation + Repair',
      status: 'done',
      ms: Date.now() - t4,
    });

    // ── STAGE 5 ────────────────────────────────────────────────────────────
    const t5 = Date.now();

    const s5 = await callClaude(
      STAGE5_EXEC_SYSTEM,
      `Check execution readiness`
    );

    pipeline.exec = s5.data;

    pipeline.stages.push({
      id: 5,
      name: 'Execution Check',
      status: 'done',
      ms: Date.now() - t5,
    });

    // ── METRICS ────────────────────────────────────────────────────────────
    pipeline.metrics = {
      total_ms: Date.now() - start,
      total_retries: totalRetries,
      issues_fixed: (pipeline.validation.issues || []).filter(
        i => i.repaired
      ).length,
      exec_score: pipeline.exec.score,
      llm_calls: 7,
      tables: pipeline.db?.tables?.length || 0,
      endpoints: pipeline.api?.endpoints?.length || 0,
      pages: pipeline.ui?.pages?.length || 0,
    };

    res.json({
      success: true,
      pipeline,
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message,
      stages_completed: pipeline.stages.length,
    });
  }
});

// ─── FRONTEND ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AppCompiler running on http://localhost:${PORT}`);
});
