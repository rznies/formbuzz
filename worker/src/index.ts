import { Hono } from 'hono';
// @ts-ignore
import formbuzzScriptText from '../formbuzz.js';

type Bindings = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
};

const app = new Hono<{ Bindings: Bindings }>();

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

export default app;
