import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../formbuzz.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.resolve(__dirname, '../formbuzz.js'), 'utf8');
  return {
    default: content
  };
});

import app from './index';

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
            return null;
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
            } else if (sql.includes("INSERT INTO message_counts")) {
              const userId = args[0];
              const periodKey = args[1];
              const existing = self.messageCounts.find(m => m.user_id === userId && m.period_key === periodKey);
              if (existing) {
                existing.count += 1;
              } else {
                self.messageCounts.push({ user_id: userId, period_key: periodKey, count: 1 });
              }
            } else if (sql.includes("UPDATE logs SET")) {
              const ref = args[0];
              const log = self.logs.find(l => l.submission_ref === ref);
              if (log) {
                log.submission_data = null;
                log.viewed_count = (log.viewed_count || 0) + 1;
              }
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

  beforeEach(() => {
    mockDb = new MockD1();
    vi.restoreAllMocks();
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

    const body = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Get Details F8X1Z9'
    }).toString();

    const res = await app.request('/v1/twilio/webhook', {
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

    const body = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Get Details AB12CD'
    }).toString();

    const res = await app.request('/v1/twilio/webhook', {
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
    const body = new URLSearchParams({
      From: 'whatsapp:+15550999',
      Body: 'F8X1Z9'
    }).toString();

    const res = await app.request('/v1/twilio/webhook', {
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

    const body = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'F8X1Z9'
    }).toString();

    const res = await app.request('/v1/twilio/webhook', {
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

    const body = new URLSearchParams({
      From: 'whatsapp:+15550100',
      Body: 'Hello World'
    }).toString();

    const res = await app.request('/v1/twilio/webhook', {
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

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response></Response>');
    expect(fetchSpy).not.toHaveBeenCalled();
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


