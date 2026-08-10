# Travel Expense Tracker (Cloudflare Worker)

An automated travel & personal expense tracker that receives message updates from a **Telegram Bot**, parses expense details using **Google Gemini AI (Structured JSON)**, and automatically logs records into a **Notion Database**.

---

## 🏗️ Architecture & Workflow

1. **User** sends an expense message (e.g., `$15 for dinner` or `150k VND for souvenirs`) to the **Telegram Bot**.
2. **Telegram Webhook** forwards the incoming update payload to the **Cloudflare Worker**.
3. **Cloudflare Worker** calls the **Google Gemini API** (`gemini-3.6-flash` model with Structured JSON schema) to extract:
   - `amount` (number)
   - `currency` (string, defaults to VND if unspecified)
   - `description` (string with category emoji prefix)
   - `date` (ISO date string)
4. Extracted payment details are posted directly to the target **Notion Database**.
5. The Worker replies back to the Telegram chat with a formatted confirmation message.

---

## 🛠️ Prerequisites

1. **Node.js**: Version 18 or higher.
2. **Cloudflare Account**: Configured with the `wrangler` CLI.
3. **Telegram Bot Token**: Create a bot via [@BotFather](https://t.me/BotFather) on Telegram.
4. **Google Gemini API Key**: Obtain an API key from [Google AI Studio](https://aistudio.google.com/).
5. **Notion Integration & Database**:
   - Create an integration at [Notion Integrations](https://www.notion.so/my-integrations) to get your `Internal Integration Token`.
   - Create a Notion Database and grant access (**Share** -> **Connect to**) to your integration.
   - The Notion Database must contain the following schema properties:
     - `description`: **Title** property
     - `amount`: **Number** property
     - `date`: **Date** property
     - `currency`: **Rich Text** property
   - **How to find your Notion Database ID**:
     1. Open your database in Notion (ensure full-page view).
     2. Click **Share** (top right) and select **Copy link**, or copy the URL directly from your browser's address bar.
     3. The URL format will look like:
        `https://www.notion.so/myworkspace/a8662bed2ab14fa38932571200c77041?v=...`
     4. Your **Database ID** is the 32-character string located after the workspace name and before the `?` query parameter (`a8662bed2ab14fa38932571200c77041` in the example above).

> ⚠️ **Important**: Remember to invite your Integration to the Notion Database (**Share** -> **Add connections** -> Select your Integration name). If omitted, the API will fail with `404 Not Found`.

---

## ⚙️ Environment Variables

| Variable Name | Type | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Secret | Google Gemini API Key | `AIzaSy...` |
| `GEMINI_MODEL` | Text | Gemini model identifier | `gemini-3.6-flash` |
| `NOTION_TOKEN` | Secret | Notion Integration Token | `ntn_...` or `secret_...` |
| `NOTION_DATABASE_ID` | Secret | Target Notion Database ID (32 hex chars) | `1234567890abcdef...` |
| `TELEGRAM_BOT_TOKEN` | Secret | Telegram Bot Authentication Token | `123456789:ABCdef...` |

---

## 🚀 Local Setup & Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Local Environment Variables
Copy `.dev.vars.example` to `.dev.vars`:
```bash
cp .dev.vars.example .dev.vars
```
Edit `.dev.vars` with your actual secret keys:
```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

NOTION_TOKEN=your_notion_token
NOTION_DATABASE_ID=your_notion_database_id

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

### 3. Run Development Server
```bash
npm run dev
```

---

## 🔒 Secret Management & Cloudflare Deployment

### 1. Login to Cloudflare CLI
```bash
npx wrangler login
```

### 2. Bulk Upload Secrets to Cloudflare Workers
Upload all key-value secrets from `.dev.vars` natively using Wrangler:
```bash
npm run secrets:upload
```
*(Or run directly: `npx wrangler secret bulk .dev.vars`)*

### 3. (Optional) Customize Worker Deployment Name
By default, the Worker is named `travel-expense-worker`. To change the deployment name and URL:
- Edit the `"name"` field in [wrangler.jsonc](file:///Users/mac/Documents/Personal/Tools/travel-expense-worker/wrangler.jsonc):
  ```jsonc
  {
    "name": "my-custom-worker-name",
    ...
  }
  ```
- Or pass the `--name` flag when deploying:
  ```bash
  npx wrangler deploy --name my-custom-worker-name
  ```

### 4. Deploy to Cloudflare Workers
```bash
npm run deploy
```
Upon successful deployment, Wrangler will output your worker's public URL:
`https://<your-worker-name>.<subdomain>.workers.dev`

### 5. Register Telegram Webhook
Register your Cloudflare Worker URL as the webhook handler for your Telegram Bot using cURL:

```bash
# Set Webhook
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://travel-expense-worker.<subdomain>.workers.dev"
```

A response of `{"ok":true,"result":true,"description":"Webhook was set"}` indicates the webhook is active.

**Other useful Webhook commands:**
```bash
# Check current Webhook status
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"

# Delete Webhook (if needed)
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```

---

## 📂 Project Structure

```
travel-expense-worker/
├── index.js               # Main Worker entry point
├── wrangler.jsonc         # Cloudflare Worker manifest configuration
├── package.json           # Scripts and devDependencies
├── .dev.vars.example      # Environment variables template
├── .dev.vars              # Local secret variables (git-ignored)
└── README.md              # Project documentation
```

---

## 📊 Live Monitoring & Logs

To stream live logs from the deployed Cloudflare Worker:
```bash
npm run tail
```
