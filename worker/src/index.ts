import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
};

const app = new Hono<{ Bindings: Bindings }>();

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

export default app;
