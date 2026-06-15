# FormBuzz 🐝

> **FormBuzz** is a serverless, zero-configuration form-to-WhatsApp notification layer built on the Cloudflare Edge network and powered by Twilio. 

Receive instant WhatsApp notifications when users submit contact forms on your website—without rebuilding your forms, paying expensive per-message fees, or setting up complex automated workflows (like Zapier or Make).

---

## ⚡ Key Features

*   **Global Auto-Capture**: Just embed a single script tag on your site. FormBuzz automatically intercepts form submissions and processes them in the background (non-blocking mirror mode).
*   **Two-Message Delivery Pattern**: Circumvents Meta's 24-hour customer service window by sending an outbound template notification with a quick-reply "View Details" button, opening the window on-demand.
*   **Zero-Trust "View and Delete" Model**: Form values are temporarily stored in D1. Once you tap "View Details" and the message is delivered, the values are permanently purged from our databases.
*   **Honeypot Bot Protection**: Injects invisible fields (`formbeep_hp` and `w2p_hp`) to catch and discard automated spam submissions silently.
*   **Domain Origin Verification**: Restricts submissions to authorized domains configured in your dashboard to prevent API key abuse.
*   **Webhook Ingestion**: Native webhook routing support for external platforms (Webflow, Jotform, Tally) via flat JSON payloads.
*   **Ultra-lightweight Dashboard**: Plain HTML/CSS/JS dashboard secured by Clerk and hosted on Cloudflare Pages.

---

## 🛠️ Technology Stack

*   **API Router**: [Hono](https://hono.dev/) on Cloudflare Workers.
*   **Database**: Cloudflare D1 (Edge-replicated SQLite).
*   **Rate-Limiting**: Cloudflare KV.
*   **Auth Gateway**: [Clerk](https://clerk.com/) (Edge JWT authentication).
*   **Messaging Gateway**: [Twilio WhatsApp API](https://www.twilio.com/en-us/messaging/channels/whatsapp).
*   **Dashboard UI**: Vanilla HTML, CSS, and JS.

---

## 📂 Directory Structure

```text
formbuzz/
├── .agents/            # AI agent development skills
├── worker/             # Serverless backend (Hono/Cloudflare Worker)
│   ├── src/
│   │   └── index.js    # API routing endpoints
│   ├── package.json
│   └── wrangler.toml   # Cloudflare environment bindings
├── dashboard/          # Plain HTML/CSS/JS user interface
│   ├── index.html      # Landing / Auth Entry
│   ├── domains.html    # Domain authorization UI
│   ├── webhooks.html   # Webhooks setup UI
│   ├── logs.html       # Delivery statistics & metrics
│   ├── styles.css      # Core UI Styling
│   └── shared.js       # Clerk & API Fetch Utilities
├── README.md           # This document
├── prd.md              # Product Requirement Document
└── issues.md           # Vertical implementation slices
```

---

## 🚀 Getting Started (Scaffolding the Worker)

To run this project locally, make sure you have [Node.js](https://nodejs.org/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-cli/) installed.

### 1. Clone the repository
```bash
git clone https://github.com/your-username/formbuzz.git
cd formbuzz
```

### 2. Configure Backend Bindings
Create local bindings for your D1 SQLite database and KV namespace:
```bash
# Initialize D1 SQLite Database
npx wrangler d1 create formbuzz-db

# Initialize KV Rate-Limit Namespace
npx wrangler kv:namespace create FORMBUZZ_LIMITS
```

Update your `worker/wrangler.toml` file with the generated database and namespace IDs.

### 3. Deploy
```bash
cd worker
npx wrangler deploy
```

---

## ⚖️ License

MIT License. See [LICENSE](LICENSE) for details.
FormBuzz is an open-source development project and is not affiliated with, endorsed by, or associated with Formbeep.
