# FormBeep: Implementation Issues

This document compiles the approved implementation issues broken down as vertical slices (tracer bullets) for the FormBeep project.

---

## Issue #1: Database Setup & Ingestion API [Triage: ready-for-agent]
### Blocked by
None - can start immediately

### What to build
Initialize a serverless Hono API backend running on Cloudflare Workers. Bootstrap a Cloudflare D1 SQLite database. Create the ingestion endpoint `POST /v1/submit/:apiKey`. 
The endpoint must:
1. Lookup the configuration in D1 using the `:apiKey`.
2. Verify that the incoming request's `Origin` or `Referer` matches the `allowed_domains` list configured for the user.
3. Validate that the payload does not contain values in the honeypot fields (`formbeep_hp` or `w2p_hp`). If bot activity is detected, silently return a `200 OK` (discarding the entry).
4. Save the valid form payload to the D1 `logs` table, generating a unique 6-character alphanumeric reference code (`submission_ref`).
5. Respond with `200 OK`.

### Acceptance criteria
- [ ] Running `wrangler dev` boots up the Hono local server.
- [ ] Database schema is initialized via `wrangler d1` migration commands.
- [ ] Sending a POST request to `/v1/submit/:apiKey` from an authorized domain successfully writes the form keys and values to the D1 database.
- [ ] Sending a POST request with honeypot fields populated returns `200 OK` but discards the payload values.
- [ ] Sending a POST request from an unauthorized domain returns `403 Forbidden`.

---

## Issue #2: Twilio Outbound Template Dispatch [Triage: ready-for-agent]
### Blocked by
- Issue #1 (Database Setup & Ingestion API)

### What to build
Integrate Twilio Programmable Messaging API to dispatch outbound WhatsApp template notifications during form ingestion.
Upon saving a form submission in `POST /v1/submit/:apiKey`:
1. Retrieve the registered phone numbers for the user from D1.
2. Construct and dispatch an HTTP POST request to the Twilio REST API messages endpoint (`/Messages.json`).
3. The message must utilize the pre-registered Twilio WhatsApp Template format: `"New form submission on {{1}}. Ref: {{2}}. Tap below to view details."` where `{{1}}` is the origin domain and `{{2}}` is the `submission_ref` generated in Issue #1.
4. Increment the message count metric in the `message_counts` table.

### Acceptance criteria
- [ ] API keys for Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`) are loaded from wrangler environment bindings.
- [ ] Form submission dispatches a fetch request to Twilio API.
- [ ] The Twilio outbound request payload contains the correct authorization headers, sender number, recipient number, and body copy.
- [ ] Log message count in D1 increments atomically upon successful dispatch.

---

## Issue #3: Twilio Webhook & "View and Delete" Delivery [Triage: ready-for-agent]
### Blocked by
- Issue #2 (Twilio Outbound Template Dispatch)

### What to build
Implement the Twilio messaging callback webhook receiver `POST /v1/twilio/webhook` to handle the quick-reply button interaction and deliver detailed data.
The endpoint must:
1. Parse Twilio's incoming request payload sent as `application/x-www-form-urlencoded`.
2. Extract the sender's phone number (`From`) and the message body (`Body`).
3. Run a regex search on the message body to isolate the 6-character alphanumeric `submission_ref`.
4. Look up the matching submission row in D1.
5. If found, format the JSON payload values into a readable key-value text message.
6. Dispatch the formatted details message to the user via Twilio.
7. Immediately update the D1 logs table, setting the `submission_data` field to `NULL` to ensure the raw values are deleted from the database.

### Acceptance criteria
- [ ] The `/v1/twilio/webhook` route correctly parses form URL-encoded body data.
- [ ] An incoming message containing a valid 6-char ref code triggers a free-form details dispatch to the user.
- [ ] After dispatch, the `submission_data` column in the D1 `logs` table is verified to be `NULL`.
- [ ] Tapping a used or invalid ref code returns a graceful error notification or does nothing.

---

## Issue #4: Client-Side Auto-Capture Engine [Triage: ready-for-agent]
### Blocked by
- Issue #1 (Database Setup & Ingestion API)

### What to build
Create the client-side `formbeep.js` script and configure the Worker to serve it dynamically.
The script must:
1. Initialize automatically on page load.
2. Read the `data-api-key` attribute from its script tag.
3. Automatically append invisible honeypot elements (`formbeep_hp` and `w2p_hp`) before each `<form>` element on the page.
4. Intercept the `submit` event of all forms, unless the form contains the `data-formbeep-ignore` attribute.
5. Traverse the DOM to resolve input element names into human-readable label elements.
6. Skip serializing individual inputs decorated with `data-formbeep-ignore`.
7. Dispatch the serialized payload to `/v1/submit/:apiKey` using `fetch` with `keepalive: true`.
8. The Worker must serve this file at `GET /v1/s/formbeep.js` with appropriate caching headers.

### Acceptance criteria
- [ ] Requesting `/v1/s/formbeep.js` returns the script with `content-type: application/javascript` and caching headers.
- [ ] Loading a page with the script tag auto-injects honeypot inputs into the DOM.
- [ ] Submitting a test form triggers a POST request to the API containing serialized inputs, while the native page submit/navigation completes normally.
- [ ] Form elements with `data-formbeep-ignore` do not trigger background dispatches.

---

## Issue #5: Third-Party Webhook Ingestion [Triage: ready-for-agent]
### Blocked by
- Issue #2 (Twilio Outbound Template Dispatch)

### What to build
Implement an incoming webhook endpoint `POST /v1/webhook/:webhookId` to receive payloads from external builders (Webflow, Jotform, Tally) that do not support custom client-side script embeds.
The endpoint must:
1. Resolve the `webhookId` against a webhook registry to find the associated user and destination phone numbers.
2. Flatten incoming nested JSON payloads so that all fields are represented as top-level key-value strings.
3. Remove common metadata fields (e.g. `eventId`, `createdAt`, `secret`).
4. Log the submission and trigger the Twilio template notification flow (matching Issue #2 logic).

### Acceptance criteria
- [ ] Sending a nested JSON payload to `/v1/webhook/:webhookId` returns `200 OK`.
- [ ] The logged payload in D1 is a flat JSON object containing only the scrubbed fields.
- [ ] The recipient receives the Twilio WhatsApp notification containing the resolved reference code.

---

## Issue #6: Clerk Auth & Dashboard UI [Triage: ready-for-agent]
### Blocked by
- Issue #1 (Database Setup & Ingestion API)

### What to build
Build the user dashboard UI using vanilla HTML/CSS/JS hosted on Cloudflare Pages, and secure the Worker APIs using Clerk JWT middleware.
1. **Frontend**: Create `index.html` (landing/login), `domains.html` (allowlist management), `webhooks.html` (webhook configuration), and `logs.html` (delivery logs and usage counters).
2. **Auth Integration**: Embed Clerk's JS library to render signup/login and store JWT session tokens.
3. **Backend Middleware**: Add Hono middleware to intercept `/v1/` admin endpoints. The middleware must fetch Clerk's JSON Web Key Set (JWKS), verify the request's Bearer JWT, and populate context variables with the validated `userId`.

### Acceptance criteria
- [ ] Pages routes are accessible, loading static HTML/CSS/JS.
- [ ] Unauthenticated API requests to `/v1/` dashboard endpoints return `401 Unauthorized`.
- [ ] Authenticated dashboard requests successfully load user-specific logs, add new authorized domains to D1, and generate new API keys.

---

## Issue #7: Worker Cron Auto-Purge & Webhook Verification [Triage: ready-for-agent]
### Blocked by
- Issue #3 (Twilio Webhook & "View and Delete" Delivery)

### What to build
Add system maintenance cron triggers and webhook signature verification.
1. **Auto-Purge**: Implement a Daily Cloudflare Worker Cron Trigger that executes a query to nullify `submission_data` in the `logs` table for records created more than 7 days ago.
2. **Signature Validation**: Implement Twilio webhook signature verification on the callback endpoint `/v1/twilio/webhook` using the `X-Twilio-Signature` header to prevent spoofing of quick-reply button taps.

### Acceptance criteria
- [ ] A simulated Worker Cron Trigger execution deletes raw data values older than 7 days while preserving metadata (e.g. field names, domain, created_at).
- [ ] Webhook requests to `/v1/twilio/webhook` with invalid Twilio signatures are rejected with `401 Unauthorized`.
