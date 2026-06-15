# Product Requirement Document (PRD) - FormBeep (Twilio Edition)

## Problem Statement

Website owners and freelancers face a critical conversion bottleneck: **leads get cold quickly**. When a potential customer fills out a website contact form, the business owner often doesn't see the email notification for hours or days because email alerts get buried in inbox noise or spam folders.

Existing solutions require building complex automated workflows (e.g., Zapier, Make) or setting up dedicated CRMs, which are expensive, time-consuming, and require technical expertise. Furthermore, direct integration with the Meta WhatsApp Business API is a complex developer chore that involves business verification, template approvals, and parsing webhook payloads.

Website owners need a **set-it-and-forget-it** notification layer that connects their existing forms to WhatsApp instantly, without rebuilding their forms, paying expensive per-message fees, or setting up complex workflows.

---

## Solution

FormBeep is a lightweight, zero-configuration form-to-WhatsApp delivery platform. 

Users copy a single-line script embed tag onto their website. The script runs silently in **mirror mode** (parallel, non-blocking dispatch) to capture form submissions, resolve field labels into human-readable text, inject invisible spam-catching honeypots, and forward the payload to an edge API Worker.

The edge backend processes the submission and sends a Twilio WhatsApp Template Message containing a `"View Details"` button. When the user taps the button on their phone, the backend dispatches a free-form message with the complete form contents and immediately purges the data from the database (implementing a zero-trust **"View and Delete"** privacy model).

---

## User Stories

1. As a freelance web developer, I want to paste a single script tag into my client's website, so that I can connect their existing forms to WhatsApp in under 2 minutes with zero HTML markup modifications.
2. As a business owner, I want to receive an instant WhatsApp notification the moment a lead form is filled, so that I can call or message the customer before my competitors do.
3. As a mobile user, I want the initial notification to contain a "View Details" button, so that I can easily fetch the full form contents on-demand.
4. As a privacy-conscious business owner, I want my customer's contact data to be deleted from FormBeep's servers as soon as I view it on WhatsApp, so that I do not accumulate third-party data liability.
5. As a website owner, I want automated spam bots to be blocked by invisible honeypot fields, so that my WhatsApp is not flooded with automated spam notifications.
6. As a developer, I want the client-side script to run completely in the background, so that even if FormBeep's API goes down, my website's native form actions and redirects work normally.
7. As a website owner, I want to authorize specific domains in my dashboard, so that malicious actors cannot steal my API key and trigger notifications from external domains.
8. As a user, I want to register incoming webhooks, so that I can route form submissions from platforms like Webflow, Jotform, or Tally without embedding a client-side script.
9. As a dashboard user, I want to sign up and log in securely using Clerk, so that I can access my API keys, set up webhook URLs, verify my phone numbers, and check delivery logs.
10. As a user, I want submissions that are caught by bot honeypots to be logged as spam in my dashboard, so that I can verify that the spam blocker is working.
11. As a business owner, I want to see my monthly message usage in the dashboard, so that I know when I am approaching my free tier limits.
12. As a user with multiple sales representatives, I want to configure multiple recipient WhatsApp numbers, so that form submissions are distributed to the correct team members.

---

## Implementation Decisions

### A. Core Architecture & Stack
* **Routing & Controllers**: Hono framework running on Cloudflare Workers.
* **Database Layer**: Cloudflare D1 (distributed SQLite) for strongly-consistent read-after-write operations.
* **State & Rate Limiting**: Cloudflare KV namespaces for low-latency rate-limiting keys.
* **Dashboard Hosting**: Plain HTML, CSS, and Vanilla JS hosted on Cloudflare Pages.
* **Auth**: Clerk JS Integration for dashboard login/signup; Worker checks Bearer JWTs via Clerk's JWKS endpoint.
* **Messaging Gateway**: Twilio Programmable Messaging API for WhatsApp.

### B. Two-Message Transaction Pattern
* Outbound template messages must be registered in the Twilio Console (e.g., `New form submission on {{1}}. Ref: {{2}}. Tap below to view details.`).
* A random 6-character alphanumeric reference code (`submission_ref`) is generated per submission.
* The raw form JSON payload is stored in the D1 `logs` table inside a text field (`submission_data`).
* When the user taps the Quick Reply button on WhatsApp, Twilio dispatches an incoming webhook (`POST /v1/twilio/webhook`) as `application/x-www-form-urlencoded`.
* The Worker extracts the reference code from the message body, formats the fields into a plain text message, sends it via Twilio's messaging endpoint, and updates the D1 log row setting `submission_data = NULL`.

### C. Client-Side Script (`formbeep.js`)
* Loaded asynchronously: `<script src="..." data-api-key="..."></script>`.
* Injects two off-screen inputs (`formbeep_hp` and `w2p_hp`) positioned absolutely off-screen.
* Captures submissions by attaching to the `submit` event of all forms.
* Employs MutationObserver to automatically bind to dynamically loaded forms (e.g. popups or single-page app views).
* Employs a label resolution algorithm to map inputs to human-readable field labels instead of raw HTML names.
* Submits via `fetch` using `keepalive: true` to prevent browser redirection from canceling the request.

---

## Testing Decisions

### A. Testing Philosophy
We only test the external boundaries (the API boundaries and client serialization output) using mocks, ensuring we don't tie tests to transient implementation details.

### B. Seams for Testing
1. **Seam 1: Form Ingestion API (`POST /v1/submit/:apiKey`)**
   * **Scope**: Verify that the endpoint authenticates the API key, checks that the origin header matches the allowed domains in D1, checks rate limits, discards honeypot values, and inserts the data into D1.
   * **Mocking**: Mock the Twilio fetch dispatch to ensure we do not hit Twilio endpoints during local automated test runs.
2. **Seam 2: Twilio Webhook Callback (`POST /v1/twilio/webhook`)**
   * **Scope**: Verify that the endpoint parses `application/x-www-form-urlencoded` payloads, resolves the reference code from the message body, fetches the correct log from D1, formats the details, dispatches the free-form Twilio message, and purges the data.
   * **Mocking**: Mock the Twilio outbound API fetch.
3. **Seam 3: Webhook Router (`POST /v1/webhook/:webhookId`)**
   * **Scope**: Verify that flat and nested JSON payloads are successfully flattened and metadata keys are scrubbed.
4. **Seam 4: Client Script Form Interceptor**
   * **Scope**: Verify that honeypots are injected, forms decorated with `data-formbeep-ignore` are bypassed, and labels are resolved correctly.

---

## Out of Scope

* **Stripe Payment Gateway**: The initial MVP release will operate on a single free/sandbox tier with fixed monthly limits. Stripe tables and subscription webhook listeners will be omitted or left inactive.
* **Visual Form Builder**: FormBeep is strictly a notification layer for existing HTML forms. It does not provide drag-and-drop form building tools.
* **CRM Tables**: FormBeep does not store a permanent, viewable record of form submissions in the dashboard. Once viewed, submission details are deleted forever.
* **Advanced Analytics**: Interactive charts showing lead conversion rates or geographical charts are out of scope.

---

## Further Notes

* **Uptime Monitoring**: The system's edge availability will be monitored via status checks.
* **Twilio Webhook Validation**: For production-grade security, the worker should optionally validate Twilio's HTTP request header (`X-Twilio-Signature`) to verify that webhook requests originate solely from Twilio.
* **Auto-Purge Job**: A daily Cloudflare Worker Cron Trigger will run `UPDATE logs SET submission_data = NULL WHERE created_at < ? AND submission_data IS NOT NULL` (checking for logs older than 7 days) to enforce data deletion compliance.
