import { describe, it, expect, beforeEach, vi } from 'vitest';
import app from './index';

class MockD1 {
  public queries: { sql: string; args: any[] }[] = [];
  public users: any[] = [];
  public logs: any[] = [];
  public messageCounts: any[] = [];

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
