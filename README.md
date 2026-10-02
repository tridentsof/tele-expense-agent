# Tele Expense Agent (Cloudflare Worker)

An automated travel & personal expense tracker that receives message updates from a **Telegram Bot**, parses expense details using **Google Vertex AI / Gemini AI (Gemini 3.7 Flash)** with Structured JSON schema, and automatically logs records into a **Notion Database**.

---

## ⚡ Quick Start: 1-Run Automated Setup

You can set up, verify, deploy, and register your Telegram webhook with a single command:

```bash
npm run setup
```
*(or `./setup.sh`)*

### What the automation script handles for you:
1. **📝 Interactive Configuration**: Prompts for AI Provider (Vertex AI / Gemini), Notion, and Telegram keys, then safely writes `.dev.vars`.
2. **🔍 Pre-flight Health Checks**:
   - Tests Telegram Bot connectivity (`getMe`) and fetches bot `@username`.
   - Tests Notion Database access and verifies required properties.
   - Tests Gemini 3.7 Flash model connectivity.
3. **☁️ Cloudflare Authentication**: Verifies `wrangler` login status and triggers browser login if needed.
4. **🚀 One-Click Deployment**:
   - Uploads all secrets automatically via `wrangler secret bulk .dev.vars`.
   - Deploys the Cloudflare Worker and extracts your public Worker URL.
5. **🔗 Automatic Telegram Webhook**: Registers your Worker URL directly with the Telegram Webhook API.

> **Non-interactive mode**: If your `.dev.vars` is already configured, run `npm run setup -- --yes` to run the entire pipeline automatically without prompts.

---

## 🏗️ Architecture & Workflow

1. **User** sends an expense message (e.g., `150k ăn trưa` or `$15 for dinner`) to the **Telegram Bot**.
2. **Telegram Webhook** forwards the incoming update payload to the **Cloudflare Worker**.
3. **Cloudflare Worker** calls **Google Vertex AI** (or **Google AI Studio**) with **Gemini 3.7 Flash** (`gemini-3.7-flash` model with Structured JSON schema) to extract:
   - `amount` (number, parses shorthands like `150k` -> `150000`)
   - `currency` (string, defaults to `VND` if unspecified)
   - `description` (string with category emoji prefix, e.g. `🍜 Ăn trưa`)
   - `date` (ISO date string)
4. Extracted payment details are posted directly to the target **Notion Database**.
5. The Worker replies back to the Telegram chat with a formatted confirmation message.

---

## 🛠️ Prerequisites

1. **Node.js**: Version 18 or higher.
2. **Cloudflare Account**: Configured with the `wrangler` CLI.
3. **Telegram Bot Token**: Create a bot via [@BotFather](https://t.me/BotFather) on Telegram.
4. **AI Provider (Vertex AI or Gemini)**:
   - **Google Vertex AI** (Recommended): API key (Express Mode) or Google Cloud IAM credentials with model `gemini-3.7-flash`.
   - **Google AI Studio**: API key from [Google AI Studio](https://aistudio.google.com/).
5. **Notion Integration & Database**:
   - Create an integration at [Notion Integrations](https://www.notion.so/my-integrations) to get your `Internal Integration Token`.
   - Create a Notion Database and grant access (**Share** -> **Add connections** -> Select your Integration name).
   - The Notion Database must contain the following schema properties:
     - `description`: **Title** property
     - `amount`: **Number** property
     - `date`: **Date** property
     - `currency`: **Rich Text** property
   - **How to find your Notion Database ID**:
     1. Open your database in Notion (full-page view).
     2. Click **Share** (top right) and select **Copy link**, or copy the URL from your browser's address bar.
     3. The URL format looks like:
        `https://www.notion.so/myworkspace/a8662bed2ab14fa38932571200c77041?v=...`
     4. Your **Database ID** is the 32-character string (`a8662bed2ab14fa38932571200c77041`). The automation script also accepts the full URL and automatically strips unnecessary query parameters.

---

## ⚙️ Environment Variables

| Variable Name | Provider | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `CLOUDFLARE_WORKER_NAME` | Deployment | Name of the Cloudflare Worker | `tele-expense-agent` |
| `LLM_PROVIDER` | Core | AI provider (`vertex` or `gemini`) | `vertex` |
| `VERTEX_MODEL` | Vertex | Gemini model for Vertex AI | `gemini-2.5-flash` |
| `VERTEX_SERVICE_ACCOUNT_PATH` | Vertex | Path to Google Service Account JSON file | `gcp-service-account.json` |
| `VERTEX_PROJECT_ID` | Vertex | GCP Project ID (auto-read from JSON file) | `video-teaching-research` |
| `VERTEX_REGION` | Vertex | GCP Region (Optional, default `us-central1`) | `us-central1` |
| `VERTEX_API_KEY` | Vertex | Vertex AI API Key (Express Mode alternative) | `AQ...` or `AIza...` |
| `GEMINI_API_KEY` | Gemini | Google AI Studio API Key | `AIza...` |
| `GEMINI_MODEL` | Gemini | Gemini model for AI Studio | `gemini-2.5-flash` |
| `NOTION_TOKEN` | Core | Notion Integration Token | `ntn_...` |
| `NOTION_DATABASE_ID` | Core | Target Notion Database ID (32 hex chars) | `fb7a2d8edf27834b9948819ad6a536e6` |
| `TELEGRAM_BOT_TOKEN` | Core | Telegram Bot Token from @BotFather | `8690497096:AAH...` |

---

## 🚀 Manual Step-by-Step Setup

If you prefer to configure and deploy manually instead of running `npm run setup`:

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Local Environment Variables
Copy `.dev.vars.example` to `.dev.vars`:
```bash
cp .dev.vars.example .dev.vars
```
Edit `.dev.vars` with your credentials:
```env
CLOUDFLARE_WORKER_NAME=tele-expense-agent
LLM_PROVIDER=vertex
VERTEX_MODEL=gemini-2.5-flash
VERTEX_SERVICE_ACCOUNT_PATH=gcp-service-account.json

NOTION_TOKEN=ntn_your_notion_token
NOTION_DATABASE_ID=your_notion_database_id

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

### 3. Run Development Server (Local)
```bash
npm run dev
```

### 4. Deploy to Cloudflare Workers
```bash
# 1. Login to Cloudflare
npx wrangler login

# 2. Upload secrets to Cloudflare Worker
npm run secrets:upload

# 3. Deploy Worker
npm run deploy
```

### 5. Register Telegram Webhook
Register your Cloudflare Worker URL with the Telegram Bot API:
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-worker-name>.<subdomain>.workers.dev"
```

**Useful Webhook diagnostics:**
```bash
# Check current Webhook status
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"

# Delete Webhook (if needed)
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```

---

## 📂 Project Structure

```
tele-expense-agent/
├── index.js               # Cloudflare Worker handler (Vertex AI & Gemini AI)
├── scripts/
│   └── setup.mjs          # Interactive & automated 1-run setup script
├── setup.sh               # Executable shell wrapper for setup
├── wrangler.jsonc         # Cloudflare Worker manifest configuration
├── package.json           # Scripts and dependencies
├── .dev.vars.example      # Environment variables template
├── .dev.vars              # Local secret variables (git-ignored)
└── README.md              # Documentation
```

---

## 📊 Live Monitoring & Logs

To stream live logs from your deployed Cloudflare Worker:
```bash
npm run tail
```
