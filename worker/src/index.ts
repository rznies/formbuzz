import { Hono } from 'hono';
import { clerkAuth } from './auth';
// @ts-ignore
import formbuzzScriptText from '../formbuzz.js';
// @ts-ignore
import dashboardIndexHtml from '../dashboard/index.html';
// @ts-ignore
import dashboardDomainsHtml from '../dashboard/domains.html';
// @ts-ignore
import dashboardWebhooksHtml from '../dashboard/webhooks.html';
// @ts-ignore
import dashboardLogsHtml from '../dashboard/logs.html';
// @ts-ignore
import dashboardStylesCss from '../dashboard/styles.css';
// @ts-ignore
import dashboardSharedJs from '../dashboard/shared.js';

type Bindings = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_ISSUER_URL: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: { userId: string } }>();


app.get('/v1/s/formbuzz.js', (c) => {
  return c.text(formbuzzScriptText, 200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=3600, s-maxage=86400',
  });
});

app.get('/v1/s/formbeep.js', (c) => {
  return c.redirect('/v1/s/formbuzz.js', 307);
});

app.post('/v1/submit/:apiKey', async (c) => {
  const apiKey = c.req.param('apiKey');
  
  // 1. Fetch User Configuration
  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE api_key = ?"
  ).bind(apiKey).first();

  if (!user) {
    return c.json({ error: "Invalid API Key" }, 401);
  }

  // 2. Allowed Domains Check
  const origin = c.req.header('Origin') || c.req.header('Referer');
  
  function extractHostname(urlStr: string | undefined): string | null {
    if (!urlStr) return null;
    try {
      const url = urlStr.startsWith('http') ? new URL(urlStr) : new URL(`http://${urlStr}`);
      return url.hostname;
    } catch {
      return null;
    }
  }

  const domain = extractHostname(origin);
  const allowed = JSON.parse((user as any).allowed_domains || "[]");

  if (!domain || allowed.length === 0 || (!allowed.includes("*") && !allowed.includes(domain))) {
    return c.json({ error: "Domain not authorized" }, 403);
  }

  // 3. Honeypot check
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  if (payload.formbuzz_hp || payload.formbeep_hp || payload.w2p_hp) {
    return c.json({ status: "success", msg: "filtered" }, 200);
  }

  // Clear honeypots from stored payload
  delete payload.formbuzz_hp;
  delete payload.formbeep_hp;
  delete payload.w2p_hp;

  // 4. Generate Reference & Save Data
  const submissionRef = generateUniqueRefCode();
  const fieldNames = JSON.stringify(Object.keys(payload));

  await c.env.DB.prepare(
    `INSERT INTO logs (user_id, domain, field_names, submission_ref, submission_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    (user as any).user_id,
    domain,
    fieldNames,
    submissionRef,
    JSON.stringify(payload),
    Date.now()
  ).run();

  // 5. Dispatch Twilio WhatsApp Template
  const recipients = JSON.parse((user as any).whatsapp_numbers || "[]");
  for (const number of recipients) {
    await sendTwilioTemplate(c.env, number, domain, submissionRef);
  }

  // 6. Update Message Counter
  const periodKey = new Date().toISOString().slice(0, 7);
  await c.env.DB.prepare(
    `INSERT INTO message_counts (user_id, period_key, count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, period_key)
     DO UPDATE SET count = count + 1`
  ).bind((user as any).user_id, periodKey).run();

  return c.json({ status: "success" }, 200);
});

app.post('/v1/twilio/webhook', async (c) => {
  const body = await c.req.parseBody();
  const senderNumber = typeof body.From === 'string' ? body.From : '';
  const incomingMessageText = typeof body.Body === 'string' ? body.Body.trim() : '';

  // 1. Clean number (e.g. whatsapp:+15550100 ➔ +15550100)
  const formattedSender = senderNumber.replace(/^whatsapp:/i, '');

  // 2. Resolve the submission reference from the incoming text (checking from right to left)
  const words = incomingMessageText.split(/\s+/);
  let refCode = '';
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    if (/^[A-Z0-9]{6}$/i.test(word)) {
      if (/^(detail|status|getref|refnum)$/i.test(word)) {
        continue;
      }
      refCode = word.toUpperCase();
      break;
    }
  }

  if (!refCode) {
    return c.text("<Response></Response>", 200, { "Content-Type": "text/xml" });
  }

  // 3. Fetch submission details
  const log = await c.env.DB.prepare(
    "SELECT * FROM logs WHERE submission_ref = ?"
  ).bind(refCode).first();

  if (!log) {
    await sendTwilioFreeform(
      c.env,
      senderNumber,
      "Submission details not found or expired."
    );
    return c.text("<Response></Response>", 200, { "Content-Type": "text/xml" });
  }

  // 4. Fetch User Configuration to verify recipient authorized
  const user = await c.env.DB.prepare(
    "SELECT whatsapp_numbers FROM users WHERE user_id = ?"
  ).bind((log as any).user_id).first();

  if (!user) {
    return c.text("<Response></Response>", 200, { "Content-Type": "text/xml" });
  }

  const whatsappNumbers = JSON.parse((user as any).whatsapp_numbers || "[]");
  if (!whatsappNumbers.includes(formattedSender)) {
    await sendTwilioFreeform(
      c.env,
      senderNumber,
      "This number is not authorized to view this submission."
    );
    return c.text("<Response></Response>", 200, { "Content-Type": "text/xml" });
  }

  // 5. Check if details already viewed/purged
  if (!(log as any).submission_data) {
    await sendTwilioFreeform(
      c.env,
      senderNumber,
      "This submission's details have already been viewed and permanently deleted."
    );
    return c.text("<Response></Response>", 200, { "Content-Type": "text/xml" });
  }

  // 6. Format Submission Details
  const data = JSON.parse((log as any).submission_data);
  let detailsText = `*Submission details for ${(log as any).domain}*\n\n`;
  for (const [key, val] of Object.entries(data)) {
    detailsText += `*${key}:* ${val}\n`;
  }

  // 7. Send Free-Form Response via Twilio
  await sendTwilioFreeform(c.env, senderNumber, detailsText);

  // 8. Permanently Purge values (View & Delete model)
  await c.env.DB.prepare(
    "UPDATE logs SET submission_data = NULL, viewed_count = viewed_count + 1 WHERE submission_ref = ?"
  ).bind(refCode).run();

  return c.text("<Response></Response>", 200, { "Content-Type": "text/xml" });
});

function generateUniqueRefCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint32Array(6);
  crypto.getRandomValues(array);
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

async function sendTwilioTemplate(
  env: { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string; TWILIO_WHATSAPP_NUMBER: string },
  number: string,
  domain: string,
  ref: string
) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const twilioNumber = env.TWILIO_WHATSAPP_NUMBER;
  
  const formattedTo = number.startsWith('whatsapp:') ? number : `whatsapp:${number}`;
  const formattedFrom = twilioNumber.startsWith('whatsapp:') ? twilioNumber : `whatsapp:${twilioNumber}`;

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: formattedFrom,
      To: formattedTo,
      Body: `New form submission on ${domain}. Ref: ${ref}. Tap below to view details.`
    })
  });
}

async function sendTwilioFreeform(
  env: { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string; TWILIO_WHATSAPP_NUMBER: string },
  to: string,
  body: string
) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const twilioNumber = env.TWILIO_WHATSAPP_NUMBER;

  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const formattedFrom = twilioNumber.startsWith('whatsapp:') ? twilioNumber : `whatsapp:${twilioNumber}`;

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: formattedFrom,
      To: formattedTo,
      Body: body
    })
  });
}

function flattenJson(obj: any, prefix = ""): Record<string, string> {
  let result: Record<string, string> = {};
  if (typeof obj !== 'object' || obj === null) {
    return result;
  }
  for (const [key, value] of Object.entries(obj)) {
    const finalKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenJson(value, finalKey));
    } else if (Array.isArray(value)) {
      result[finalKey] = value.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join(", ");
    } else if (value === null || value === undefined) {
      result[finalKey] = "";
    } else {
      result[finalKey] = String(value);
    }
  }
  return result;
}

app.post('/v1/webhook/:webhookId', async (c) => {
  const webhookId = c.req.param('webhookId');
  let rawPayload: any;
  try {
    rawPayload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  // 1. Fetch Webhook Configuration
  const webhook = await c.env.DB.prepare(
    "SELECT * FROM webhooks WHERE id = ?"
  ).bind(webhookId).first();

  if (!webhook) {
    return c.json({ error: "Invalid webhook ID" }, 404);
  }

  // 2. Fetch User Configuration
  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE user_id = ?"
  ).bind((webhook as any).user_id).first();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  // 3. Flatten and clean payload
  const cleanedPayload = flattenJson(rawPayload);
  const ignoreKeys = ['event', 'eventId', 'createdAt', 'webhookId', 'timestamp', 'secret'];
  for (const key of Object.keys(cleanedPayload)) {
    const lastSegment = key.split('.').pop() || '';
    if (ignoreKeys.includes(lastSegment)) {
      delete cleanedPayload[key];
    }
  }

  // 4. Generate Reference & Save Data
  const submissionRef = generateUniqueRefCode();
  const fieldNames = JSON.stringify(Object.keys(cleanedPayload));

  await c.env.DB.prepare(
    `INSERT INTO logs (user_id, domain, field_names, submission_ref, submission_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    (user as any).user_id,
    (webhook as any).name,
    fieldNames,
    submissionRef,
    JSON.stringify(cleanedPayload),
    Date.now()
   ).run();

  // 5. Dispatch Twilio WhatsApp Template
  const recipients = JSON.parse((webhook as any).whatsapp_numbers || (user as any).whatsapp_numbers || "[]");
  for (const number of recipients) {
    await sendTwilioTemplate(c.env, number, (webhook as any).name, submissionRef);
  }

  // 6. Update Message Counter
  const periodKey = new Date().toISOString().slice(0, 7);
  await c.env.DB.prepare(
    `INSERT INTO message_counts (user_id, period_key, count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, period_key)
     DO UPDATE SET count = count + 1`
  ).bind((user as any).user_id, periodKey).run();

  return c.json({ status: "success" }, 200);
});

// ─── Dashboard Static Asset Routes ────────────────────────────────────────────

function serveHtml(c: any, html: string) {
  const pk = c.env.CLERK_PUBLISHABLE_KEY || '';
  const content = html.replace(/\{\{CLERK_PUBLISHABLE_KEY\}\}/g, pk);
  return c.html(content);
}

app.get('/dashboard', (c) => serveHtml(c, dashboardIndexHtml));
app.get('/dashboard/domains', (c) => serveHtml(c, dashboardDomainsHtml));
app.get('/dashboard/webhooks', (c) => serveHtml(c, dashboardWebhooksHtml));
app.get('/dashboard/logs', (c) => serveHtml(c, dashboardLogsHtml));

app.get('/dashboard/styles.css', (c) => {
  return c.text(dashboardStylesCss, 200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
});

app.get('/dashboard/shared.js', (c) => {
  return c.text(dashboardSharedJs, 200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
});

// ─── Dashboard API Routes (Protected by Clerk Auth) ──────────────────────────

function generateApiKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint32Array(24);
  crypto.getRandomValues(array);
  let result = 'fbz_';
  for (let i = 0; i < 24; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

function generateWebhookId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint32Array(16);
  crypto.getRandomValues(array);
  let result = 'wh_';
  for (let i = 0; i < 16; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

// Apply auth middleware to all /v1/dashboard/* routes
app.use('/v1/dashboard/*', clerkAuth);

// GET /v1/dashboard/me — Profile with auto-provisioning
app.get('/v1/dashboard/me', async (c) => {
  const userId = c.get('userId');

  let user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE user_id = ?"
  ).bind(userId).first();

  // Auto-provision new user on first authenticated request
  if (!user) {
    const apiKey = generateApiKey();
    await c.env.DB.prepare(
      `INSERT INTO users (user_id, api_key, plan, whatsapp_numbers, allowed_domains, created_at)
       VALUES (?, ?, 'free', '[]', '[]', ?)`
    ).bind(userId, apiKey, Date.now()).run();

    user = await c.env.DB.prepare(
      "SELECT * FROM users WHERE user_id = ?"
    ).bind(userId).first();
  }

  // Get current month message count
  const periodKey = new Date().toISOString().slice(0, 7);
  const mc = await c.env.DB.prepare(
    "SELECT count FROM message_counts WHERE user_id = ? AND period_key = ?"
  ).bind(userId, periodKey).first();

  return c.json({
    user_id: (user as any).user_id,
    api_key: (user as any).api_key,
    plan: (user as any).plan,
    whatsapp_numbers: JSON.parse((user as any).whatsapp_numbers || '[]'),
    allowed_domains: JSON.parse((user as any).allowed_domains || '[]'),
    message_count: mc ? (mc as any).count : 0,
    created_at: (user as any).created_at,
  });
});

// GET /v1/dashboard/domains — Current allowed_domains
app.get('/v1/dashboard/domains', async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare(
    "SELECT allowed_domains FROM users WHERE user_id = ?"
  ).bind(userId).first();

  if (!user) return c.json({ error: 'User not found' }, 404);

  return c.json({
    domains: JSON.parse((user as any).allowed_domains || '[]'),
  });
});

// PUT /v1/dashboard/domains — Replace allowed_domains
app.put('/v1/dashboard/domains', async (c) => {
  const userId = c.get('userId');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || !Array.isArray(body.domains)) {
    return c.json({ error: 'Body must contain a "domains" array' }, 400);
  }

  // Validate each domain is a non-empty string
  for (const d of body.domains) {
    if (typeof d !== 'string' || !d.trim()) {
      return c.json({ error: 'Each domain must be a non-empty string' }, 400);
    }
  }

  const domainsJson = JSON.stringify(body.domains.map((d: string) => d.trim().toLowerCase()));
  await c.env.DB.prepare(
    "UPDATE users SET allowed_domains = ? WHERE user_id = ?"
  ).bind(domainsJson, userId).run();

  return c.json({ status: 'updated', domains: JSON.parse(domainsJson) });
});

// GET /v1/dashboard/webhooks — List user's webhooks
app.get('/v1/dashboard/webhooks', async (c) => {
  const userId = c.get('userId');
  const result = await c.env.DB.prepare(
    "SELECT id, name, whatsapp_numbers, created_at FROM webhooks WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(userId).all();

  const webhooks = (result.results || []).map((wh: any) => ({
    id: wh.id,
    name: wh.name,
    whatsapp_numbers: wh.whatsapp_numbers ? JSON.parse(wh.whatsapp_numbers) : null,
    created_at: wh.created_at,
  }));

  return c.json({ webhooks });
});

// POST /v1/dashboard/webhooks — Create a webhook
app.post('/v1/dashboard/webhooks', async (c) => {
  const userId = c.get('userId');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'Body must contain a "name" string' }, 400);
  }

  const webhookId = generateWebhookId();
  const whatsappNumbers = body.whatsapp_numbers && Array.isArray(body.whatsapp_numbers)
    ? JSON.stringify(body.whatsapp_numbers)
    : null;

  await c.env.DB.prepare(
    `INSERT INTO webhooks (id, user_id, name, whatsapp_numbers, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(webhookId, userId, body.name.trim(), whatsappNumbers, Date.now()).run();

  return c.json({
    status: 'created',
    webhook: {
      id: webhookId,
      name: body.name.trim(),
      whatsapp_numbers: body.whatsapp_numbers || null,
    }
  }, 201);
});

// DELETE /v1/dashboard/webhooks/:id — Delete a webhook
app.delete('/v1/dashboard/webhooks/:id', async (c) => {
  const userId = c.get('userId');
  const webhookId = c.req.param('id');

  const webhook = await c.env.DB.prepare(
    "SELECT user_id FROM webhooks WHERE id = ?"
  ).bind(webhookId).first();

  if (!webhook) {
    return c.json({ error: 'Webhook not found' }, 404);
  }

  if ((webhook as any).user_id !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    "DELETE FROM webhooks WHERE id = ?"
  ).bind(webhookId).run();

  return c.json({ status: 'deleted' });
});

// GET /v1/dashboard/logs — Paginated submission logs
app.get('/v1/dashboard/logs', async (c) => {
  const userId = c.get('userId');
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15')));
  const offset = (page - 1) * limit;

  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM logs WHERE user_id = ?"
  ).bind(userId).first();

  const result = await c.env.DB.prepare(
    `SELECT id, domain, field_names, delivery_status, submission_ref, viewed_count, created_at
     FROM logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(userId, limit, offset).all();

  return c.json({
    logs: result.results || [],
    total: countResult ? (countResult as any).total : 0,
    page,
    limit,
  });
});

export default app;

