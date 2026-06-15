import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { SignJWT, importPKCS8, exportJWK, generateKeyPair } from 'jose';

vi.mock('../formbuzz.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.resolve(__dirname, '../formbuzz.js'), 'utf8');
  return {
    default: content
  };
});

// Mock dashboard assets as empty strings — they are text imports
vi.mock('../dashboard/index.html', () => ({ default: '<html>dashboard</html>' }));
vi.mock('../dashboard/domains.html', () => ({ default: '<html>domains</html>' }));
vi.mock('../dashboard/webhooks.html', () => ({ default: '<html>webhooks</html>' }));
vi.mock('../dashboard/logs.html', () => ({ default: '<html>logs</html>' }));
vi.mock('../dashboard/styles.css', () => ({ default: 'body{}' }));
vi.mock('../dashboard/shared.js', () => ({ default: '// shared' }));

import worker, { app } from './index';

async function signTwilioRequest(url: string, params: URLSearchParams, authToken: string) {
  const sorted = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const payload = url + sorted.map(([key, value]) => `${key}${value}`).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

declare global {
  interface Response {
    json(): Promise<any>;
  }
}
import { _resetJWKSCache } from './auth';

class MockD1 {
  public queries: { sql: string; args: any[] }[] = [];
  public users: any[] = [];
  public logs: any[] = [];
  public messageCounts: any[] = [];
  public webhooks: any[] = [];

  prepare(sql: string) {
    const self = this;
    return {
      bind(...args: any[]) {
        self.queries.push({ sql, args });
        return {
          async first() {
            if (sql.includes("SELECT * FROM users WHERE api_key = ?")) {
              const apiKey = args[0];
              return self.users.find(u => u.api_key === apiKey) || null;
            }
            if (sql.includes("SELECT * FROM logs WHERE submission_ref = ?")) {
              const ref = args[0];
              return self.logs.find(l => l.submission_ref === ref) || null;
            }
            if (sql.includes("FROM users WHERE user_id = ?")) {
              const userId = args[0];
              return self.users.find(u => u.user_id === userId) || null;
            }
            if (sql.includes("SELECT * FROM webhooks WHERE id = ?")) {
              const webhookId = args[0];
              return self.webhooks.find(w => w.id === webhookId) || null;
            }
            if (sql.includes("SELECT user_id FROM webhooks WHERE id = ?")) {
              const webhookId = args[0];
              const wh = self.webhooks.find(w => w.id === webhookId);
              return wh ? { user_id: wh.user_id } : null;
            }
            if (sql.includes("SELECT count FROM message_counts")) {
              const userId = args[0];
              const periodKey = args[1];
              const mc = self.messageCounts.find(m => m.user_id === userId && m.period_key === periodKey);
              return mc ? { count: mc.count } : null;
            }
            if (sql.includes("SELECT COUNT(*) as total FROM logs")) {
              const userId = args[0];
              const total = self.logs.filter(l => l.user_id === userId).length;
              return { total };
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM webhooks WHERE user_id = ?")) {
              const userId = args[0];
              return { results: self.webhooks.filter(w => w.user_id === userId) };
            }
            if (sql.includes("FROM logs WHERE user_id = ?")) {
              const userId = args[0];
              const limit = args[1] || 15;
              const offset = args[2] || 0;
              const userLogs = self.logs
                .filter(l => l.user_id === userId)
                .sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
                .slice(offset, offset + limit)
                .map((l: any) => {
                  // Simulate SQL column selection: dashboard logs query omits submission_data
                  if (!sql.includes('submission_data')) {
                    const { submission_data, ...rest } = l;
                    return rest;
                  }
                  return l;
                });
              return { results: userLogs };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO logs")) {
              self.logs.push({
                user_id: args[0],
                domain: args[1],
                field_names: args[2],
                submission_ref: args[3],
                submission_data: args[4],
                created_at: args[5],
                viewed_count: 0,
              });
            } else if (sql.includes("INSERT INTO users")) {
              self.users.push({
                user_id: args[0],
                api_key: args[1],
                plan: 'free',
                whatsapp_numbers: '[]',
                allowed_domains: '[]',
                created_at: args[2],
              });
            } else if (sql.includes("INSERT INTO message_counts")) {
              const userId = args[0];
              const periodKey = args[1];
              const existing = self.messageCounts.find(m => m.user_id === userId && m.period_key === periodKey);
              if (existing) {
                existing.count += 1;
              } else {
                self.messageCounts.push({ user_id: userId, period_key: periodKey, count: 1 });
              }
            } else if (sql.includes("INSERT INTO webhooks")) {
              self.webhooks.push({
                id: args[0],
                user_id: args[1],
                name: args[2],
                whatsapp_numbers: args[3],
                created_at: args[4],
              });
            } else if (sql.includes("UPDATE logs SET")) {
              if (sql.includes("created_at < ?")) {
                const cutoff = args[0];
                self.logs.forEach(l => {
                  if (l.created_at < cutoff && l.submission_data !== null) {
                    l.submission_data = null;
                  }
                });
              } else {
                const ref = args[0];
                const log = self.logs.find(l => l.submission_ref === ref);
                if (log) {
                  log.submission_data = null;
                  log.viewed_count = (log.viewed_count || 0) + 1;
                }
              }
            } else if (sql.includes("UPDATE users SET allowed_domains")) {
              const domains = args[0];
              const userId = args[1];
              const user = self.users.find(u => u.user_id === userId);
              if (user) user.allowed_domains = domains;
            } else if (sql.includes("DELETE FROM webhooks")) {
              const webhookId = args[0];
              const idx = self.webhooks.findIndex(w => w.id === webhookId);
              if (idx !== -1) self.webhooks.splice(idx, 1);
            }
            return { success: true };
          }
        };
      }
    };
  }
}

describe('FormBuzz Ingestion API - POST /v1/submit/:apiKey', () => {
  let mockDb: MockD1;

  beforeEach(() => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
  });

  it('should return 401 Unauthorized if the API key does not exist', async () => {
    const res = await app.request('/v1/submit/fbp_invalid_key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid API Key' });
  });

  it('should return 403 Forbidden if allowed_domains is empty []', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '[]',
      whatsapp_numbers: '[]'
    });

    const res = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Domain not authorized' });
  });

  it('should return 403 Forbidden if allowed_domains does not include the request domain', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["different.com"]',
      whatsapp_numbers: '[]'
    });

    const res = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Domain not authorized' });
  });

  it('should allow the request if allowed_domains contains wildcard "*"', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '[]'
    });

    const res = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
  });

  it('should allow the request if allowed_domains matches the request domain from Origin or Referer', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["example.com"]',
      whatsapp_numbers: '[]'
    });

    const res1 = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://example.com/some/path'
      },
      body: JSON.stringify({ name: 'Alice' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });
    expect(res2.status).toBe(200);
  });

  it('should filter out submissions with formbuzz_hp honeypot filled', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const res = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice', formbuzz_hp: 'spam-bot' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'success', msg: 'filtered' });
    expect(mockDb.logs.length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should filter out submissions with backward-compatible honeypots (formbeep_hp, w2p_hp)', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    // Test formbeep_hp
    const res1 = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice', formbeep_hp: 'bot' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ status: 'success', msg: 'filtered' });

    // Test w2p_hp
    const res2 = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://example.com'
      },
      body: JSON.stringify({ name: 'Alice', w2p_hp: 'bot' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ status: 'success', msg: 'filtered' });

    expect(mockDb.logs.length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should successfully log the submission to D1, dispatch Twilio WhatsApp templates to all recipients, and increment the message count', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100", "+15550200"]'
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const res = await app.request('/v1/submit/fbp_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://test.com'
      },
      body: JSON.stringify({ name: 'John', email: 'john@example.com', formbuzz_hp: '', formbeep_hp: '', w2p_hp: '' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'success' });

    // Assert database log entry
    expect(mockDb.logs.length).toBe(1);
    const log = mockDb.logs[0];
    expect(log.user_id).toBe('user_1');
    expect(log.domain).toBe('test.com');
    expect(JSON.parse(log.field_names)).toEqual(['name', 'email']);
    expect(log.submission_ref).toMatch(/^[A-Z0-9]{6}$/);
    
    // Check that honeypot fields are removed from logs even if present in body but empty
    const submissionData = JSON.parse(log.submission_data);
    expect(submissionData).toEqual({ name: 'John', email: 'john@example.com' });
    expect(submissionData.formbuzz_hp).toBeUndefined();
    expect(submissionData.formbeep_hp).toBeUndefined();
    expect(submissionData.w2p_hp).toBeUndefined();

    // Assert Twilio dispatches
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    
    // Get call arguments and verify them
    const calls = fetchSpy.mock.calls;
    const url = 'https://api.twilio.com/2010-04-01/Accounts/ACmock/Messages.json';
    
    expect(calls[0][0]).toBe(url);
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[0][1]?.headers).toBeDefined();
    
    const body1 = new URLSearchParams(calls[0][1]?.body as any);
    expect(body1.get('From')).toBe('whatsapp:+14155552671');
    expect(body1.get('To')).toBe('whatsapp:+15550100');
    expect(body1.get('Body')).toContain('test.com');
    expect(body1.get('Body')).toContain(log.submission_ref);

    expect(calls[1][0]).toBe(url);
    const body2 = new URLSearchParams(calls[1][1]?.body as any);
    expect(body2.get('To')).toBe('whatsapp:+15550200');

    // Assert message count updated
    const currentPeriod = new Date().toISOString().slice(0, 7);
    expect(mockDb.messageCounts.length).toBe(1);
    const mc = mockDb.messageCounts[0];
    expect(mc.user_id).toBe('user_1');
    expect(mc.period_key).toBe(currentPeriod);
    expect(mc.count).toBe(1);
  });
});

describe('Twilio Webhook - POST /v1/twilio/webhook', () => {
  let mockDb: MockD1;
  const webhookUrl = 'https://api.formbuzz.test/v1/twilio/webhook';

  beforeEach(() => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
  });

  it('should reject requests with missing signature', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'test.com',
      field_names: '["name", "email"]',
      submission_ref: 'F8X1Z9',
      submission_data: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      created_at: Date.now(),
      viewed_count: 0
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const body = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Get Details F8X1Z9'
    }).toString();

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Verify DB not mutated
    const log = mockDb.logs[0];
    expect(log.submission_data).not.toBeNull();
    expect(log.viewed_count).toBe(0);
  });

  it('should reject requests with invalid signature', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'test.com',
      field_names: '["name", "email"]',
      submission_ref: 'F8X1Z9',
      submission_data: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      created_at: Date.now(),
      viewed_count: 0
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const body = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Get Details F8X1Z9'
    }).toString();

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'invalid_sig'
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Verify DB not mutated
    const log = mockDb.logs[0];
    expect(log.submission_data).not.toBeNull();
    expect(log.viewed_count).toBe(0);
  });

  it('should parse body, extract ref, verify authorized sender, send details, and purge submission_data', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'test.com',
      field_names: '["name", "email"]',
      submission_ref: 'F8X1Z9',
      submission_data: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      created_at: Date.now(),
      viewed_count: 0
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const params = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Get Details F8X1Z9'
    });
    const body = params.toString();
    const signature = await signTwilioRequest(webhookUrl, params, 'mock_token');

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/xml');
    expect(await res.text()).toBe('<Response></Response>');

    // Verify Twilio dispatch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calls = fetchSpy.mock.calls;
    const url = 'https://api.twilio.com/2010-04-01/Accounts/ACmock/Messages.json';
    expect(calls[0][0]).toBe(url);
    const bodySent = new URLSearchParams(calls[0][1]?.body as any);
    expect(bodySent.get('From')).toBe('whatsapp:+14155552671');
    expect(bodySent.get('To')).toBe('whatsapp:+15550100');
    expect(bodySent.get('Body')).toContain('Submission details for test.com');
    expect(bodySent.get('Body')).toContain('*name:* Alice');
    expect(bodySent.get('Body')).toContain('*email:* alice@example.com');

    // Verify DB update
    const log = mockDb.logs[0];
    expect(log.submission_data).toBeNull();
    expect(log.viewed_count).toBe(1);
  });

  it('should notify user if submission ref is not found', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const params = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Get Details AB12CD'
    });
    const body = params.toString();
    const signature = await signTwilioRequest(webhookUrl, params, 'mock_token');

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response></Response>');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const bodySent = new URLSearchParams(fetchSpy.mock.calls[0][1]?.body as any);
    expect(bodySent.get('Body')).toBe('Submission details not found or expired.');
  });

  it('should not allow access and send warning if sender is not authorized', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'test.com',
      field_names: '["name"]',
      submission_ref: 'F8X1Z9',
      submission_data: JSON.stringify({ name: 'Alice' }),
      created_at: Date.now(),
      viewed_count: 0
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    // Sender is +15550999 (Unauthorized)
    const params = new URLSearchParams({
      From: 'whatsapp:+15550999',
      Body: 'F8X1Z9'
    });
    const body = params.toString();
    const signature = await signTwilioRequest(webhookUrl, params, 'mock_token');

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response></Response>');

    // Should receive warning message
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const bodySent = new URLSearchParams(fetchSpy.mock.calls[0][1]?.body as any);
    expect(bodySent.get('To')).toBe('whatsapp:+15550999');
    expect(bodySent.get('Body')).toBe('This number is not authorized to view this submission.');

    // DB should NOT be purged
    const log = mockDb.logs[0];
    expect(log.submission_data).not.toBeNull();
    expect(log.viewed_count).toBe(0);
  });

  it('should notify if submission is already viewed and deleted', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'test.com',
      field_names: '["name"]',
      submission_ref: 'F8X1Z9',
      submission_data: null, // already viewed/deleted
      created_at: Date.now(),
      viewed_count: 1
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const params = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'F8X1Z9'
    });
    const body = params.toString();
    const signature = await signTwilioRequest(webhookUrl, params, 'mock_token');

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response></Response>');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const bodySent = new URLSearchParams(fetchSpy.mock.calls[0][1]?.body as any);
    expect(bodySent.get('Body')).toBe("This submission's details have already been viewed and permanently deleted.");
  });

  it('should ignore incoming message if no 6-character alphanumeric reference code is detected', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const params = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Hello World'
    });
    const body = params.toString();
    const signature = await signTwilioRequest(webhookUrl, params, 'mock_token');

    const res = await app.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature
      },
      body
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response></Response>');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Scheduled purge', () => {
  let mockDb: MockD1;

  beforeEach(() => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
  });

  it('should purge sensitive logs older than 7 days and leave recent or already-purged logs unchanged', async () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const sixDaysAgo = now - 6 * 24 * 60 * 60 * 1000;
    const nineDaysAgo = now - 9 * 24 * 60 * 60 * 1000;

    // Seed logs
    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'old.com',
      field_names: '["email"]',
      submission_ref: 'OLD123',
      submission_data: JSON.stringify({ email: 'old@example.com' }),
      created_at: eightDaysAgo,
      viewed_count: 0,
      delivery_status: 'sent'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'recent.com',
      field_names: '["email"]',
      submission_ref: 'REC123',
      submission_data: JSON.stringify({ email: 'recent@example.com' }),
      created_at: sixDaysAgo,
      viewed_count: 0,
      delivery_status: 'sent'
    });

    mockDb.logs.push({
      user_id: 'user_1',
      domain: 'purged.com',
      field_names: '["email"]',
      submission_ref: 'PRG123',
      submission_data: null,
      created_at: nineDaysAgo,
      viewed_count: 2,
      delivery_status: 'sent'
    });

    await worker.scheduled(
      {} as ScheduledEvent,
      { DB: mockDb as any } as any,
      {} as ExecutionContext
    );

    const oldLog = mockDb.logs.find(l => l.submission_ref === 'OLD123');
    expect(oldLog.submission_data).toBeNull();
    expect(oldLog.viewed_count).toBe(0);
    expect(oldLog.domain).toBe('old.com');
    expect(oldLog.delivery_status).toBe('sent');

    const recentLog = mockDb.logs.find(l => l.submission_ref === 'REC123');
    expect(JSON.parse(recentLog.submission_data)).toEqual({ email: 'recent@example.com' });
    expect(recentLog.viewed_count).toBe(0);

    const purgedLog = mockDb.logs.find(l => l.submission_ref === 'PRG123');
    expect(purgedLog.submission_data).toBeNull();
    expect(purgedLog.viewed_count).toBe(2);
  });
});

describe('Client-Side Script Server - GET /v1/s/formbuzz.js', () => {
  it('should serve the formbuzz.js script with correct Content-Type and Cache-Control headers', async () => {
    const res = await app.request('/v1/s/formbuzz.js', {
      method: 'GET'
    }, {
      DB: {} as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600, s-maxage=86400');
    const text = await res.text();
    expect(text).toContain('__FORMBUZZ_TEST__');
    expect(text).toContain('VERSION = "1.4.0"');
  });

  it('should redirect GET /v1/s/formbeep.js to /v1/s/formbuzz.js with status 307', async () => {
    const res = await app.request('/v1/s/formbeep.js', {
      method: 'GET'
    }, {
      DB: {} as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(307);
    expect(res.headers.get('Location')).toBe('/v1/s/formbuzz.js');
  });
});

describe('formbuzz.js Client Script Logic Unit Tests', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  let cleanLabel: (text: string) => string;
  let resolveFieldLabel: (field: any) => string;
  let serializeForm: (form: any) => Record<string, string>;

  beforeEach(() => {
    // Reset globalThis.__FORMBUZZ_TEST__ and mock document / window
    delete (globalThis as any).__FORMBUZZ_TEST__;
    (globalThis as any).window = {};
    (globalThis as any).document = {
      readyState: 'complete',
      addEventListener: () => {},
      currentScript: {
        getAttribute: (name: string) => name === 'data-api-key' ? 'fbp_test_key' : null,
        src: 'https://api.formbuzz.com/v1/s/formbuzz.js'
      },
      querySelectorAll: () => []
    };

    // Load/evaluate formbuzz.js
    const scriptPath = path.resolve(__dirname, '../formbuzz.js');
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    
    // Evaluate script
    const runScript = new Function(scriptContent);
    runScript();

    const testObject = (globalThis as any).__FORMBUZZ_TEST__;
    expect(testObject).toBeDefined();

    cleanLabel = testObject.cleanLabel;
    resolveFieldLabel = testObject.resolveFieldLabel;
    serializeForm = testObject.serializeForm;
  });

  describe('cleanLabel', () => {
    it('should strip trailing colons, asterisks, and whitespaces', () => {
      expect(cleanLabel('Email Address: *')).toBe('Email Address');
      expect(cleanLabel('Name *:')).toBe('Name');
      expect(cleanLabel('  Phone Number:  ')).toBe('Phone Number');
      expect(cleanLabel('Age')).toBe('Age');
    });
  });

  describe('resolveFieldLabel', () => {
    it('should resolve label from explicit label[for]', () => {
      // Mock document.querySelector
      (globalThis as any).document.querySelector = (selector: string) => {
        if (selector === 'label[for="input-id"]') {
          return { textContent: 'Explicit Label *:' };
        }
        return null;
      };

      const field = {
        id: 'input-id',
        name: 'test-name',
        getAttribute: () => null
      };

      expect(resolveFieldLabel(field)).toBe('Explicit Label');
    });

    it('should resolve label from parent label element', () => {
      // Setup a parent label
      const mockParent = {
        tagName: 'LABEL',
        childNodes: [
          { nodeType: 3, textContent: 'Parent Label Text: ' },
          { nodeType: 1, tagName: 'INPUT' }
        ]
      };

      const field = {
        parentElement: mockParent,
        name: 'test-name',
        getAttribute: () => null
      };

      expect(resolveFieldLabel(field)).toBe('Parent Label Text');
    });

    it('should resolve label from previous sibling label element', () => {
      const mockSibling = {
        tagName: 'LABEL',
        textContent: 'Sibling Label:'
      };

      const field = {
        name: 'test-name',
        previousElementSibling: mockSibling,
        getAttribute: () => null
      };

      expect(resolveFieldLabel(field)).toBe('Sibling Label');
    });

    it('should resolve label from previous sibling element with form-label class', () => {
      const mockSibling = {
        tagName: 'DIV',
        className: 'form-label',
        textContent: 'Class Label:'
      };

      const field = {
        name: 'test-name',
        previousElementSibling: mockSibling,
        getAttribute: () => null
      };

      expect(resolveFieldLabel(field)).toBe('Class Label');
    });

    it('should resolve label from aria-label attribute', () => {
      const field = {
        getAttribute: (attr: string) => attr === 'aria-label' ? 'Aria Label' : null
      };

      expect(resolveFieldLabel(field)).toBe('Aria Label');
    });

    it('should resolve label from placeholder attribute', () => {
      const field = {
        placeholder: 'Placeholder Label',
        getAttribute: () => null
      };

      expect(resolveFieldLabel(field)).toBe('Placeholder Label');
    });

    it('should fallback to name if no label found', () => {
      const field = {
        name: 'field_name',
        getAttribute: () => null
      };

      expect(resolveFieldLabel(field)).toBe('field_name');
    });
  });

  describe('serializeForm', () => {
    it('should serialize form fields and ignore ignored/disabled/buttons', () => {
      const fields = [
        { name: 'name', value: 'Alice', type: 'text', disabled: false, hasAttribute: () => false, getAttribute: () => null },
        { name: 'email', value: 'alice@test.com', type: 'email', disabled: false, hasAttribute: () => false, getAttribute: () => null },
        { name: 'ignored_field', value: 'blah', type: 'text', disabled: false, hasAttribute: (attr: string) => attr === 'data-formbuzz-ignore', getAttribute: () => null },
        { name: 'disabled_field', value: 'blah', type: 'text', disabled: true, hasAttribute: () => false, getAttribute: () => null },
        { name: 'submit_btn', value: 'Submit', type: 'submit', disabled: false, hasAttribute: () => false, getAttribute: () => null }
      ];

      const form = {
        elements: fields
      };

      // Set global document querySelector to return null for labels
      (globalThis as any).document.querySelector = () => null;

      const payload = serializeForm(form);
      expect(payload).toEqual({
        name: 'Alice',
        email: 'alice@test.com'
      });
    });

    it('should serialize file inputs using filenames', () => {
      const fileField = {
        name: 'resume',
        type: 'file',
        files: [
          { name: 'resume.pdf' },
          { name: 'cover_letter.pdf' }
        ],
        disabled: false,
        hasAttribute: () => false,
        getAttribute: () => null
      };

      const form = {
        elements: [fileField]
      };

      const payload = serializeForm(form);
      expect(payload).toEqual({
        resume: 'resume.pdf, cover_letter.pdf'
      });
    });

    it('should serialize select-multiple inputs', () => {
      const selectField = {
        name: 'colors',
        type: 'select-multiple',
        options: [
          { selected: true, value: 'red', text: 'Red' },
          { selected: false, value: 'green', text: 'Green' },
          { selected: true, value: 'blue', text: 'Blue' }
        ],
        disabled: false,
        hasAttribute: () => false,
        getAttribute: () => null
      };

      const form = {
        elements: [selectField]
      };

      const payload = serializeForm(form);
      expect(payload).toEqual({
        colors: 'red, blue'
      });
    });

    it('should serialize multiple checkboxes with the same name/label by joining their values', () => {
      const mockSibling = {
        tagName: 'DIV',
        className: 'form-label',
        textContent: 'Hobbies:'
      };

      const fields = [
        { name: 'hobby', value: 'reading', type: 'checkbox', checked: true, previousElementSibling: mockSibling, disabled: false, hasAttribute: () => false, getAttribute: () => null },
        { name: 'hobby', value: 'sports', type: 'checkbox', checked: true, previousElementSibling: mockSibling, disabled: false, hasAttribute: () => false, getAttribute: () => null },
        { name: 'hobby', value: 'music', type: 'checkbox', checked: false, previousElementSibling: mockSibling, disabled: false, hasAttribute: () => false, getAttribute: () => null }
      ];

      const form = {
        elements: fields
      };

      const payload = serializeForm(form);
      expect(payload).toEqual({
        Hobbies: 'reading, sports'
      });
    });
  });
});

describe('Third-Party Webhook Router - POST /v1/webhook/:webhookId', () => {
  let mockDb: MockD1;

  beforeEach(() => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
  });

  it('should return 404 if the webhookId does not exist in the database', async () => {
    const res = await app.request('/v1/webhook/wh_invalid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: 'hello' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invalid webhook ID' });
  });

  it('should return 404 if the owner user of the webhook does not exist', async () => {
    mockDb.webhooks.push({
      id: 'wh_valid',
      user_id: 'user_nonexistent',
      name: 'Test Webhook',
      whatsapp_numbers: '["+15550100"]'
    });

    const res = await app.request('/v1/webhook/wh_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: 'hello' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'User not found' });
  });

  it('should return 400 for invalid JSON payload', async () => {
    mockDb.webhooks.push({
      id: 'wh_valid',
      user_id: 'user_1',
      name: 'Test Webhook',
      whatsapp_numbers: '["+15550100"]'
    });

    const res = await app.request('/v1/webhook/wh_valid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{ invalid-json }'
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON payload' });
  });

  it('should successfully flatten and scrub the payload, log to D1, send Twilio messages, and increment message counter', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.webhooks.push({
      id: 'wh_1',
      user_id: 'user_1',
      name: 'Webflow Integration',
      whatsapp_numbers: null
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const payload = {
      name: 'Bob',
      contact: {
        email: 'bob@test.com',
        phone: '555-1234'
      },
      metadata: {
        secret: 'should-be-removed',
        event: 'form-submit'
      },
      tags: ['alpha', 'beta'],
      timestamp: 123456789
    };

    const res = await app.request('/v1/webhook/wh_1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success' });

    // Assert log entry in D1
    expect(mockDb.logs.length).toBe(1);
    const log = mockDb.logs[0];
    expect(log.user_id).toBe('user_1');
    expect(log.domain).toBe('Webflow Integration');
    expect(JSON.parse(log.field_names)).toEqual(['name', 'contact.email', 'contact.phone', 'tags']);
    expect(log.submission_ref).toMatch(/^[A-Z0-9]{6}$/);

    const submissionData = JSON.parse(log.submission_data);
    expect(submissionData).toEqual({
      name: 'Bob',
      'contact.email': 'bob@test.com',
      'contact.phone': '555-1234',
      tags: 'alpha, beta'
    });
    // Verify metadata keys are scrubbed
    expect(submissionData['metadata.secret']).toBeUndefined();
    expect(submissionData['metadata.event']).toBeUndefined();
    expect(submissionData.event).toBeUndefined();
    expect(submissionData.eventId).toBeUndefined();
    expect(submissionData.createdAt).toBeUndefined();
    expect(submissionData.webhookId).toBeUndefined();
    expect(submissionData.timestamp).toBeUndefined();
    expect(submissionData.secret).toBeUndefined();

    // Assert Twilio template sent to user default recipient
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const bodySent = new URLSearchParams(fetchSpy.mock.calls[0][1]?.body as any);
    expect(bodySent.get('To')).toBe('whatsapp:+15550100');
    expect(bodySent.get('Body')).toContain('Webflow Integration');
    expect(bodySent.get('Body')).toContain(log.submission_ref);

    // Assert message count updated
    const currentPeriod = new Date().toISOString().slice(0, 7);
    expect(mockDb.messageCounts.length).toBe(1);
    const mc = mockDb.messageCounts[0];
    expect(mc.user_id).toBe('user_1');
    expect(mc.period_key).toBe(currentPeriod);
    expect(mc.count).toBe(1);
  });

  it('should override recipient numbers if whatsapp_numbers is defined at the webhook level', async () => {
    mockDb.users.push({
      user_id: 'user_1',
      api_key: 'fbp_valid',
      allowed_domains: '["*"]',
      whatsapp_numbers: '["+15550100"]'
    });

    mockDb.webhooks.push({
      id: 'wh_1',
      user_id: 'user_1',
      name: 'Overridden Integration',
      whatsapp_numbers: '["+15550999", "+15550888"]'
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 }));
    });

    const res = await app.request('/v1/webhook/wh_1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: 'hi' })
    }, {
      DB: mockDb as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671'
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const call1 = new URLSearchParams(fetchSpy.mock.calls[0][1]?.body as any);
    const call2 = new URLSearchParams(fetchSpy.mock.calls[1][1]?.body as any);

    expect(call1.get('To')).toBe('whatsapp:+15550999');
    expect(call2.get('To')).toBe('whatsapp:+15550888');
  });
});


// ─── Clerk Auth & Dashboard Test Infrastructure ──────────────────────────────

// Generate an RSA key pair for signing test JWTs
let testKeys: { publicKey: CryptoKey; privateKey: CryptoKey; jwk: any } | null = null;

async function getTestKeys() {
  if (testKeys) return testKeys;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  testKeys = { publicKey, privateKey, jwk };
  return testKeys;
}

async function signTestJWT(claims: Record<string, any>, privateKey: CryptoKey) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('https://test.clerk.accounts.dev')
    .sign(privateKey);
}

function createAuthEnv(mockDb: MockD1) {
  return {
    DB: mockDb as any,
    TWILIO_ACCOUNT_SID: 'ACmock',
    TWILIO_AUTH_TOKEN: 'mock_token',
    TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671',
    CLERK_PUBLISHABLE_KEY: 'pk_test_mock',
    CLERK_SECRET_KEY: 'sk_test_mock',
    CLERK_ISSUER_URL: 'https://test.clerk.accounts.dev',
  };
}

// ─── Clerk Auth Middleware Tests ─────────────────────────────────────────────

describe('Clerk Auth Middleware', () => {
  let mockDb: MockD1;

  beforeEach(async () => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
    _resetJWKSCache();

    // Mock fetch to serve the test JWKS when the middleware requests it
    const keys = await getTestKeys();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [keys.jwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 });
    });
  });

  it('should return 401 when no Authorization header is present', async () => {
    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Missing Authorization header');
  });

  it('should return 401 when Authorization header has invalid format', async () => {
    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
      headers: { 'Authorization': 'Basic abc123' },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid Authorization format');
  });

  it('should return 401 when JWT signature is invalid (signed with wrong key)', async () => {
    // Generate a separate key pair that the server doesn't know about
    const { privateKey: wrongKey } = await generateKeyPair('RS256');
    const token = await signTestJWT({ sub: 'user_attacker' }, wrongKey);

    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid token');
  });

  it('should return 401 when JWT is expired', async () => {
    const keys = await getTestKeys();
    const token = await new SignJWT({ sub: 'user_expired' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer('https://test.clerk.accounts.dev')
      .sign(keys.privateKey);

    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Token expired');
  });

  it('should allow request and set userId when JWT is valid', async () => {
    const keys = await getTestKeys();
    const token = await signTestJWT({ sub: 'user_valid_123' }, keys.privateKey);

    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe('user_valid_123');
  });
});

// ─── Dashboard API: GET /v1/dashboard/me ────────────────────────────────────

describe('Dashboard API - GET /v1/dashboard/me', () => {
  let mockDb: MockD1;

  beforeEach(async () => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
    _resetJWKSCache();

    const keys = await getTestKeys();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [keys.jwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 });
    });
  });

  it('should auto-create user on first auth and return new API key with fbz_ prefix', async () => {
    const keys = await getTestKeys();
    const token = await signTestJWT({ sub: 'user_new_auto' }, keys.privateKey);

    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe('user_new_auto');
    expect(body.api_key).toMatch(/^fbz_/);
    expect(body.api_key.length).toBe(28); // fbz_ + 24 chars
    expect(body.plan).toBe('free');
    expect(body.message_count).toBe(0);
    expect(mockDb.users.length).toBe(1);
  });

  it('should return existing user profile with usage count', async () => {
    const keys = await getTestKeys();
    const periodKey = new Date().toISOString().slice(0, 7);
    mockDb.users.push({
      user_id: 'user_existing',
      api_key: 'fbz_existingkey123456789012',
      plan: 'starter',
      whatsapp_numbers: '["+15550100"]',
      allowed_domains: '["example.com"]',
      created_at: Date.now(),
    });
    mockDb.messageCounts.push({ user_id: 'user_existing', period_key: periodKey, count: 42 });

    const token = await signTestJWT({ sub: 'user_existing' }, keys.privateKey);

    const res = await app.request('/v1/dashboard/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_key).toBe('fbz_existingkey123456789012');
    expect(body.plan).toBe('starter');
    expect(body.message_count).toBe(42);
    expect(body.whatsapp_numbers).toEqual(['+15550100']);
    expect(body.allowed_domains).toEqual(['example.com']);
    // Should NOT create a new user
    expect(mockDb.users.length).toBe(1);
  });
});

// ─── Dashboard API: Domains ─────────────────────────────────────────────────

describe('Dashboard API - Domains', () => {
  let mockDb: MockD1;
  let authToken: string;

  beforeEach(async () => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
    _resetJWKSCache();

    const keys = await getTestKeys();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [keys.jwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 });
    });

    mockDb.users.push({
      user_id: 'user_domains',
      api_key: 'fbz_domains_test_key1234567',
      plan: 'free',
      whatsapp_numbers: '[]',
      allowed_domains: '["example.com", "test.com"]',
      created_at: Date.now(),
    });

    authToken = await signTestJWT({ sub: 'user_domains' }, keys.privateKey);
  });

  it('GET /v1/dashboard/domains returns current allowed_domains', async () => {
    const res = await app.request('/v1/dashboard/domains', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domains).toEqual(['example.com', 'test.com']);
  });

  it('PUT /v1/dashboard/domains updates allowed_domains', async () => {
    const res = await app.request('/v1/dashboard/domains', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: ['new-domain.com', 'localhost'] }),
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('updated');
    expect(body.domains).toEqual(['new-domain.com', 'localhost']);

    // Verify DB was updated
    const user = mockDb.users.find(u => u.user_id === 'user_domains');
    expect(JSON.parse(user.allowed_domains)).toEqual(['new-domain.com', 'localhost']);
  });

  it('PUT /v1/dashboard/domains rejects invalid body', async () => {
    const res = await app.request('/v1/dashboard/domains', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domains: 'not-an-array' }),
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('domains');
  });
});

// ─── Dashboard API: Webhooks ────────────────────────────────────────────────

describe('Dashboard API - Webhooks', () => {
  let mockDb: MockD1;
  let authToken: string;

  beforeEach(async () => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
    _resetJWKSCache();

    const keys = await getTestKeys();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [keys.jwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 });
    });

    mockDb.users.push({
      user_id: 'user_wh',
      api_key: 'fbz_webhook_test_key123456',
      plan: 'free',
      whatsapp_numbers: '[]',
      allowed_domains: '[]',
      created_at: Date.now(),
    });

    authToken = await signTestJWT({ sub: 'user_wh' }, keys.privateKey);
  });

  it('GET /v1/dashboard/webhooks returns user webhooks', async () => {
    mockDb.webhooks.push({
      id: 'wh_test1',
      user_id: 'user_wh',
      name: 'Webflow Integration',
      whatsapp_numbers: null,
      created_at: Date.now(),
    });

    const res = await app.request('/v1/dashboard/webhooks', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.webhooks.length).toBe(1);
    expect(body.webhooks[0].name).toBe('Webflow Integration');
  });

  it('POST /v1/dashboard/webhooks creates a new webhook', async () => {
    const res = await app.request('/v1/dashboard/webhooks', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Tally Forms', whatsapp_numbers: ['+15550100'] }),
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('created');
    expect(body.webhook.name).toBe('Tally Forms');
    expect(body.webhook.id).toMatch(/^wh_/);
    expect(mockDb.webhooks.length).toBe(1);
    expect(mockDb.webhooks[0].user_id).toBe('user_wh');
  });

  it('DELETE /v1/dashboard/webhooks/:id deletes the webhook', async () => {
    mockDb.webhooks.push({
      id: 'wh_delete_me',
      user_id: 'user_wh',
      name: 'To Delete',
      whatsapp_numbers: null,
      created_at: Date.now(),
    });

    const res = await app.request('/v1/dashboard/webhooks/wh_delete_me', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('deleted');
    expect(mockDb.webhooks.length).toBe(0);
  });

  it('DELETE /v1/dashboard/webhooks/:id prevents deleting another user webhook (403)', async () => {
    mockDb.webhooks.push({
      id: 'wh_other_user',
      user_id: 'user_other',
      name: 'Not Mine',
      whatsapp_numbers: null,
      created_at: Date.now(),
    });

    const res = await app.request('/v1/dashboard/webhooks/wh_other_user', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    // Webhook should still exist
    expect(mockDb.webhooks.length).toBe(1);
  });
});

// ─── Dashboard API: Logs ────────────────────────────────────────────────────

describe('Dashboard API - Logs', () => {
  let mockDb: MockD1;
  let authToken: string;

  beforeEach(async () => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
    _resetJWKSCache();

    const keys = await getTestKeys();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('.well-known/jwks.json')) {
        return new Response(JSON.stringify({ keys: [keys.jwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sid: 'SMmock' }), { status: 200 });
    });

    mockDb.users.push({
      user_id: 'user_logs',
      api_key: 'fbz_logs_test_key123456789',
      plan: 'free',
      whatsapp_numbers: '[]',
      allowed_domains: '[]',
      created_at: Date.now(),
    });

    authToken = await signTestJWT({ sub: 'user_logs' }, keys.privateKey);
  });

  it('GET /v1/dashboard/logs returns paginated logs without submission_data', async () => {
    // Add some test logs
    for (let i = 0; i < 3; i++) {
      mockDb.logs.push({
        id: i + 1,
        user_id: 'user_logs',
        domain: `site${i}.com`,
        field_names: '["name","email"]',
        delivery_status: i === 0 ? 'sent' : 'pending',
        submission_ref: `REF00${i}`,
        submission_data: i === 0 ? null : '{"name":"test"}',
        viewed_count: i === 0 ? 1 : 0,
        created_at: Date.now() - (i * 1000),
      });
    }

    const res = await app.request('/v1/dashboard/logs?page=1&limit=10', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs.length).toBe(3);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);

    // Verify submission_data is NOT included in the response
    for (const log of body.logs) {
      expect(log.submission_data).toBeUndefined();
      expect(log.domain).toBeDefined();
      expect(log.submission_ref).toBeDefined();
    }
  });

  it('GET /v1/dashboard/logs supports pagination', async () => {
    // Add 5 logs
    for (let i = 0; i < 5; i++) {
      mockDb.logs.push({
        id: i + 1,
        user_id: 'user_logs',
        domain: `site${i}.com`,
        field_names: '["name"]',
        delivery_status: 'sent',
        submission_ref: `PG${i}ABC`,
        viewed_count: 0,
        created_at: Date.now() - (i * 1000),
      });
    }

    const res = await app.request('/v1/dashboard/logs?page=2&limit=2', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` },
    }, createAuthEnv(mockDb));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs.length).toBe(2);
    expect(body.total).toBe(5);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(2);
  });
});

// ─── Dashboard Static Asset Routes ──────────────────────────────────────────

describe('Dashboard Static Asset Routes', () => {
  it('GET /dashboard serves HTML with Clerk publishable key injected', async () => {
    const res = await app.request('/dashboard', {
      method: 'GET',
    }, {
      DB: {} as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671',
      CLERK_PUBLISHABLE_KEY: 'pk_test_injected',
      CLERK_SECRET_KEY: 'sk_test_mock',
      CLERK_ISSUER_URL: 'https://test.clerk.accounts.dev',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('GET /dashboard/styles.css serves CSS with correct Content-Type', async () => {
    const res = await app.request('/dashboard/styles.css', {
      method: 'GET',
    }, {
      DB: {} as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671',
      CLERK_PUBLISHABLE_KEY: 'pk_test_mock',
      CLERK_SECRET_KEY: 'sk_test_mock',
      CLERK_ISSUER_URL: 'https://test.clerk.accounts.dev',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/css');
  });

  it('GET /dashboard/shared.js serves JavaScript with correct Content-Type', async () => {
    const res = await app.request('/dashboard/shared.js', {
      method: 'GET',
    }, {
      DB: {} as any,
      TWILIO_ACCOUNT_SID: 'ACmock',
      TWILIO_AUTH_TOKEN: 'mock_token',
      TWILIO_WHATSAPP_NUMBER: 'whatsapp:+14155552671',
      CLERK_PUBLISHABLE_KEY: 'pk_test_mock',
      CLERK_SECRET_KEY: 'sk_test_mock',
      CLERK_ISSUER_URL: 'https://test.clerk.accounts.dev',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/javascript');
  });
});
