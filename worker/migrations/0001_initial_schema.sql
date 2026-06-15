-- Initial Schema Migration for FormBuzz

-- 1. User accounts and configuration
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,               -- Clerk user identifier (e.g., user_...)
  api_key TEXT UNIQUE NOT NULL,           -- Prefix-based API key (e.g., fbp_...)
  plan TEXT DEFAULT 'free',               -- 'free', 'starter', 'pro', 'business', 'agency'
  whatsapp_numbers TEXT DEFAULT '[]',     -- JSON array of verified numbers: ["+15550100", ...]
  allowed_domains TEXT DEFAULT '[]',      -- JSON array of allowed origins: ["example.com", "localhost"]
  stripe_customer_id TEXT,                -- Stripe customer reference
  subscription_status TEXT,               -- Stripe subscription state (active, trialing, past_due)
  subscription_expires_at INTEGER,        -- Unix timestamp in ms
  created_at INTEGER NOT NULL             -- Unix timestamp in ms
);
CREATE INDEX idx_users_api_key ON users(api_key);

-- 2. Message counters (atomic usage trackers for billing cycles)
CREATE TABLE message_counts (
  user_id TEXT NOT NULL,
  period_key TEXT NOT NULL,               -- Format: "YYYY-MM" (billing period key)
  count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, period_key)
);

-- 3. Submission logs (For dashboard reporting and WhatsApp data retrieval)
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  field_names TEXT,                       -- JSON array of keys submitted (e.g., '["Name", "Email"]')
  recipients_count INTEGER,               -- Number of WhatsApp accounts this was sent to
  delivery_status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed'
  submission_ref TEXT UNIQUE,             -- High-entropy short identifier for WhatsApp callback link
  submission_data TEXT,                   -- JSON object string (sensitive values; nulled after viewing)
  viewed_count INTEGER DEFAULT 0,         -- Tracking button clicks
  created_at INTEGER NOT NULL,            -- Unix timestamp in ms
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX idx_logs_user_id ON logs(user_id);
CREATE INDEX idx_logs_submission_ref ON logs(submission_ref);

-- 4. Third-party webhook registries
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,                    -- Unique webhook identifier
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- Integration name (e.g., 'Webflow Integration')
  whatsapp_numbers TEXT,                  -- JSON array overriding user defaults: ["+15550100", ...]
  created_at INTEGER NOT NULL,            -- Unix timestamp in ms
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX idx_webhooks_user_id ON webhooks(user_id);
