#!/usr/bin/env node

/**
 * All-In-One Automated Setup Script for Tele Expense Agent
 * Configures Vertex AI / Gemini AI, Notion, Telegram Bot, Cloudflare Worker deployment,
 * and automatically sets up the Telegram Webhook in one run.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { exec, spawn } from "child_process";
import { fileURLToPath } from "url";
import dns from "dns/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const devVarsPath = path.join(rootDir, ".dev.vars");
const wranglerConfigPath = path.join(rootDir, "wrangler.jsonc");

// ANSI color helpers
const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m"
};

const c = {
    bold: (t) => `${colors.bold}${t}${colors.reset}`,
    green: (t) => `${colors.green}${t}${colors.reset}`,
    cyan: (t) => `${colors.cyan}${t}${colors.reset}`,
    yellow: (t) => `${colors.yellow}${t}${colors.reset}`,
    red: (t) => `${colors.red}${t}${colors.reset}`,
    magenta: (t) => `${colors.magenta}${t}${colors.reset}`,
    dim: (t) => `${colors.dim}${t}${colors.reset}`
};

function banner() {
    console.log(`
${colors.cyan}╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🤖  ${colors.bold}TELE EXPENSE AGENT - AUTOMATED SETUP${colors.reset}${colors.cyan}            ║
║       Cloudflare Workers • Vertex AI • Telegram • Notion  ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝${colors.reset}
`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        skipPrompts: args.includes("--yes") || args.includes("-y") || args.includes("--skip-prompts"),
        help: args.includes("--help") || args.includes("-h")
    };
}

function createPromptReader() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return {
        question: (promptText, defaultVal = "") => {
            return new Promise((resolve) => {
                const displayPrompt = defaultVal ? `${promptText} [${defaultVal}]: ` : `${promptText}: `;
                rl.question(displayPrompt, (answer) => {
                    const res = answer.trim() || defaultVal;
                    resolve(res);
                });
            });
        },
        close: () => rl.close()
    };
}

function parseDotEnv(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    const result = {};
    for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
            const key = line.slice(0, eqIdx).trim();
            let val = line.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            result[key] = val;
        }
    }
    return result;
}

function writeDotEnv(filePath, envObj) {
    let output = "# Tele Expense Agent Environment Variables (.dev.vars)\n";
    output += `# Generated automatically on ${new Date().toISOString()}\n\n`;

    output += `LLM_PROVIDER=${envObj.LLM_PROVIDER || "vertex"}\n`;
    if (envObj.LLM_PROVIDER === "vertex") {
        output += `VERTEX_MODEL=${envObj.VERTEX_MODEL || "gemini-3.7-flash"}\n`;
        if (envObj.VERTEX_API_KEY) output += `VERTEX_API_KEY=${envObj.VERTEX_API_KEY}\n`;
        if (envObj.VERTEX_PROJECT_ID) output += `VERTEX_PROJECT_ID=${envObj.VERTEX_PROJECT_ID}\n`;
        if (envObj.VERTEX_REGION) output += `VERTEX_REGION=${envObj.VERTEX_REGION}\n`;
        if (envObj.VERTEX_SERVICE_ACCOUNT_KEY) output += `VERTEX_SERVICE_ACCOUNT_KEY=${envObj.VERTEX_SERVICE_ACCOUNT_KEY}\n`;
        if (envObj.VERTEX_BEARER_TOKEN) output += `VERTEX_BEARER_TOKEN=${envObj.VERTEX_BEARER_TOKEN}\n`;
    } else {
        output += `GEMINI_MODEL=${envObj.GEMINI_MODEL || "gemini-3.7-flash"}\n`;
        if (envObj.GEMINI_API_KEY) output += `GEMINI_API_KEY=${envObj.GEMINI_API_KEY}\n`;
    }

    // Also include GEMINI_API_KEY as fallback if available
    if (envObj.VERTEX_API_KEY && !envObj.GEMINI_API_KEY) {
        output += `GEMINI_API_KEY=${envObj.VERTEX_API_KEY}\n`;
    }

    output += `\n# Cloudflare Worker Deployment Name\n`;
    output += `CLOUDFLARE_WORKER_NAME=${envObj.CLOUDFLARE_WORKER_NAME || "tele-expense-agent"}\n`;

    output += `\nNOTION_TOKEN=${envObj.NOTION_TOKEN || ""}\n`;
    output += `NOTION_DATABASE_ID=${cleanDatabaseId(envObj.NOTION_DATABASE_ID || "")}\n`;
    output += `TELEGRAM_BOT_TOKEN=${envObj.TELEGRAM_BOT_TOKEN || ""}\n`;

    fs.writeFileSync(filePath, output, "utf-8");
}

function getWranglerName() {
    try {
        const conf = fs.readFileSync(wranglerConfigPath, "utf-8");
        const m = conf.match(/"name":\s*"([^"]+)"/);
        return m ? m[1] : "tele-expense-agent";
    } catch (_) {
        return "tele-expense-agent";
    }
}

function updateWranglerName(newName) {
    if (!newName) return;
    try {
        let conf = fs.readFileSync(wranglerConfigPath, "utf-8");
        conf = conf.replace(/"name":\s*"[^"]+"/, `"name": "${newName}"`);
        fs.writeFileSync(wranglerConfigPath, conf, "utf-8");
    } catch (_) {}
}

function cleanDatabaseId(raw) {
    if (!raw) return "";
    let clean = raw.split("?")[0].trim();
    const parts = clean.split("/");
    const lastPart = parts[parts.length - 1];
    return lastPart.replace(/-/g, "");
}

function execAsync(cmd, options = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd: rootDir, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function testTelegram(token) {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.description || "Invalid Telegram Bot Token");
    }
    return data.result;
}

async function testNotion(token, databaseId) {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2022-06-28"
        }
    });
    if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try {
            const j = JSON.parse(text);
            if (j.message) msg = j.message;
        } catch (_) {}
        throw new Error(`Notion error: ${msg}. Make sure you invited your Integration to this database!`);
    }
    const data = await res.json();
    const title = data.title?.[0]?.plain_text || "Untitled Database";
    return { title, properties: Object.keys(data.properties || {}) };
}

let cachedOAuthToken = null;
let cachedTokenExpiry = 0;

async function getGoogleOAuthToken(saKeyInput) {
    const now = Math.floor(Date.now() / 1000);
    if (cachedOAuthToken && cachedTokenExpiry > now + 60) {
        return cachedOAuthToken;
    }

    let sa;
    if (typeof saKeyInput === "string") {
        try {
            sa = JSON.parse(saKeyInput);
        } catch (_) {
            try {
                sa = JSON.parse(Buffer.from(saKeyInput, "base64").toString("utf-8"));
            } catch (e) {
                throw new Error("Invalid VERTEX_SERVICE_ACCOUNT_KEY format: must be valid JSON or base64 JSON string");
            }
        }
    } else {
        sa = saKeyInput;
    }

    if (!sa.client_email || !sa.private_key) {
        throw new Error("VERTEX_SERVICE_ACCOUNT_KEY missing client_email or private_key");
    }

    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
        iss: sa.client_email,
        sub: sa.client_email,
        aud: sa.token_uri || "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
        scope: "https://www.googleapis.com/auth/cloud-platform"
    };

    const b64Url = (obj) => {
        const str = typeof obj === "string" ? obj : JSON.stringify(obj);
        return Buffer.from(str).toString("base64url");
    };

    const signingInput = `${b64Url(header)}.${b64Url(payload)}`;

    const pem = sa.private_key
        .replace(/-----BEGIN [A-Z ]+-----/g, "")
        .replace(/-----END [A-Z ]+-----/g, "")
        .replace(/\s+/g, "");

    const derBuffer = Buffer.from(pem, "base64");

    const key = await crypto.subtle.importKey(
        "pkcs8",
        derBuffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput)
    );

    const signatureB64Url = Buffer.from(signature).toString("base64url");
    const jwt = `${signingInput}.${signatureB64Url}`;

    const tokenRes = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt
        })
    });

    if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Failed to obtain Google OAuth2 token: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    cachedOAuthToken = tokenData.access_token;
    cachedTokenExpiry = now + (tokenData.expires_in || 3600);
    return cachedOAuthToken;
}

async function testAI(env) {
    const provider = env.LLM_PROVIDER || "vertex";
    let model = env.VERTEX_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash";
    const headers = { "Content-Type": "application/json" };
    let endpoint;

    if (provider === "vertex") {
        let saObj = null;
        if (env.VERTEX_SERVICE_ACCOUNT_KEY) {
            try {
                saObj = typeof env.VERTEX_SERVICE_ACCOUNT_KEY === "string"
                    ? JSON.parse(env.VERTEX_SERVICE_ACCOUNT_KEY)
                    : env.VERTEX_SERVICE_ACCOUNT_KEY;
            } catch (_) {
                try {
                    saObj = JSON.parse(Buffer.from(env.VERTEX_SERVICE_ACCOUNT_KEY, "base64").toString("utf-8"));
                } catch (e) {}
            }
        }

        const projectId = env.VERTEX_PROJECT_ID || saObj?.project_id;
        const region = env.VERTEX_REGION || env.VERTEX_LOCATION || "us-central1";

        if (projectId) {
            endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
        } else {
            endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`;
        }

        if (env.VERTEX_SERVICE_ACCOUNT_KEY) {
            const token = await getGoogleOAuthToken(env.VERTEX_SERVICE_ACCOUNT_KEY);
            headers["Authorization"] = `Bearer ${token}`;
        } else if (env.VERTEX_BEARER_TOKEN) {
            headers["Authorization"] = `Bearer ${env.VERTEX_BEARER_TOKEN}`;
        } else if (env.VERTEX_API_KEY || env.GEMINI_API_KEY) {
            const apiKey = env.VERTEX_API_KEY || env.GEMINI_API_KEY;
            headers["x-goog-api-key"] = apiKey;
            endpoint += `?key=${encodeURIComponent(apiKey)}`;
        } else {
            throw new Error("Missing Vertex AI credentials (VERTEX_SERVICE_ACCOUNT_KEY, VERTEX_API_KEY, or GEMINI_API_KEY)");
        }
    } else {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("Missing GEMINI_API_KEY for Gemini AI Studio");
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        headers["x-goog-api-key"] = apiKey;
    }

    let res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }]
        })
    });

    if (!res.ok && res.status === 404 && provider === "vertex" && model !== "gemini-2.5-flash") {
        model = "gemini-2.5-flash";
        const projectId = env.VERTEX_PROJECT_ID || "video-teaching-research";
        const region = env.VERTEX_REGION || "us-central1";
        endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
        res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: "ping" }] }]
            })
        });
    }

    if (!res.ok) {
        const text = await res.text();
        let clean = text;
        try {
            const j = JSON.parse(text);
            if (j.error?.message) clean = j.error.message;
        } catch (_) {}
        throw new Error(`${clean}`);
    }

    return { ok: true, provider, model };
}

async function runInteractiveWranglerLogin() {
    return new Promise((resolve, reject) => {
        console.log(c.yellow("\n⚠️ Cloudflare authentication required. Launching browser login...\n"));
        const child = spawn("npx", ["wrangler", "login"], {
            cwd: rootDir,
            stdio: "inherit"
        });
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Wrangler login exited with code ${code}`));
        });
    });
}

async function main() {
    const { skipPrompts, help } = parseArgs();
    if (help) {
        banner();
        console.log(`Usage:
  ${c.cyan("npm run setup")}                 Interactive setup, health check & deployment
  ${c.cyan("npm run setup -- --yes")}        Run non-interactively using existing .dev.vars
  ${c.cyan("./setup.sh")}                    Direct script execution
  ${c.cyan("./setup.sh --help")}             Show this help message
`);
        process.exit(0);
    }

    banner();
    const prompt = createPromptReader();

    try {
        // STEP 1: CONFIGURATION
        console.log(c.bold("\n[Step 1/5] 📝 Environment & Secrets Configuration\n"));

        let env = parseDotEnv(devVarsPath);
        const hasExisting = fs.existsSync(devVarsPath) &&
            (env.VERTEX_SERVICE_ACCOUNT_KEY || env.VERTEX_API_KEY || env.GEMINI_API_KEY || env.VERTEX_BEARER_TOKEN) &&
            env.TELEGRAM_BOT_TOKEN &&
            env.NOTION_TOKEN;

        let shouldPrompt = !hasExisting || !skipPrompts;

        if (hasExisting && !skipPrompts) {
            console.log(c.green("Found existing .dev.vars configuration:"));
            console.log(`  • Worker:   ${c.cyan(env.CLOUDFLARE_WORKER_NAME || getWranglerName())}`);
            console.log(`  • Provider: ${c.cyan(env.LLM_PROVIDER || "vertex")}`);
            console.log(`  • Model:    ${c.cyan(env.VERTEX_MODEL || env.GEMINI_MODEL || "gemini-3.7-flash")}`);
            console.log(`  • Database: ${c.cyan(cleanDatabaseId(env.NOTION_DATABASE_ID))}`);
            console.log(`  • Bot:      ${c.cyan(env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.slice(0, 10) + "..." : "not set")}\n`);

            const answer = await prompt.question("Use existing .dev.vars configuration? (Y/n)", "Y");
            if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
                shouldPrompt = false;
            }
        }

        if (shouldPrompt) {
            console.log(c.cyan("Cloudflare Worker Configuration:"));
            env.CLOUDFLARE_WORKER_NAME = await prompt.question(
                "Cloudflare Worker Deployment Name",
                env.CLOUDFLARE_WORKER_NAME || getWranglerName() || "tele-expense-agent"
            );
            updateWranglerName(env.CLOUDFLARE_WORKER_NAME);

            console.log(c.cyan("\nSelect AI Provider:"));
            console.log("  1) Google Vertex AI (Gemini 3.7 Flash) [Recommended]");
            console.log("  2) Google AI Studio (Gemini 3.7 Flash)");
            const providerChoice = await prompt.question("Choice (1 or 2)", env.LLM_PROVIDER === "gemini" ? "2" : "1");
            const provider = providerChoice === "2" ? "gemini" : "vertex";
            env.LLM_PROVIDER = provider;

            if (provider === "vertex") {
                console.log(c.cyan("\nVertex AI Authentication Method:"));
                console.log("  1) Google Service Account JSON (Recommended for Google Cloud)");
                console.log("  2) Vertex API Key (Express Mode)");
                const authChoice = await prompt.question("Choice (1 or 2)", env.VERTEX_SERVICE_ACCOUNT_KEY ? "1" : "2");
                if (authChoice === "1") {
                    const defaultPath = fs.existsSync(path.join(rootDir, "gcp-service-account.json")) ? "gcp-service-account.json" : "";
                    const saPath = await prompt.question("Path to Service Account JSON file", defaultPath);
                    if (saPath && fs.existsSync(path.resolve(rootDir, saPath))) {
                        const rawJson = fs.readFileSync(path.resolve(rootDir, saPath), "utf-8");
                        env.VERTEX_SERVICE_ACCOUNT_KEY = Buffer.from(rawJson).toString("base64");
                        try {
                            const parsed = JSON.parse(rawJson);
                            env.VERTEX_PROJECT_ID = parsed.project_id || env.VERTEX_PROJECT_ID;
                        } catch (_) {}
                    }
                } else {
                    env.VERTEX_API_KEY = await prompt.question(
                        "Vertex AI / Google API Key (Express Mode)",
                        env.VERTEX_API_KEY || env.GEMINI_API_KEY || ""
                    );
                }
                env.VERTEX_MODEL = await prompt.question("Vertex Model", env.VERTEX_MODEL || "gemini-2.5-flash");
                env.VERTEX_REGION = await prompt.question("GCP Region", env.VERTEX_REGION || "us-central1");
            } else {
                env.GEMINI_MODEL = await prompt.question("Gemini Model", env.GEMINI_MODEL || "gemini-2.5-flash");
                env.GEMINI_API_KEY = await prompt.question("Google Gemini API Key", env.GEMINI_API_KEY || "");
            }

            console.log(c.cyan("\nNotion Configuration:"));
            env.NOTION_TOKEN = await prompt.question("Notion Internal Integration Token (ntn_...)", env.NOTION_TOKEN || "");
            const rawDb = await prompt.question("Notion Database ID (or full Notion URL)", env.NOTION_DATABASE_ID || "");
            env.NOTION_DATABASE_ID = cleanDatabaseId(rawDb);

            console.log(c.cyan("\nTelegram Configuration:"));
            env.TELEGRAM_BOT_TOKEN = await prompt.question("Telegram Bot Token (from @BotFather)", env.TELEGRAM_BOT_TOKEN || "");

            writeDotEnv(devVarsPath, env);
            console.log(c.green("\n✅ Saved settings to .dev.vars"));
        } else {
            // Clean database ID just in case
            env.NOTION_DATABASE_ID = cleanDatabaseId(env.NOTION_DATABASE_ID);
            if (!env.CLOUDFLARE_WORKER_NAME) {
                env.CLOUDFLARE_WORKER_NAME = getWranglerName();
            }
        }

        // STEP 2: HEALTH CHECKS
        console.log(c.bold("\n[Step 2/5] 🔍 Pre-flight Verification & Health Checks\n"));

        // 2a. Telegram Check
        process.stdout.write("  • Checking Telegram Bot Token... ");
        let botInfo;
        try {
            botInfo = await testTelegram(env.TELEGRAM_BOT_TOKEN);
            console.log(c.green(`OK! (@${botInfo.username} - "${botInfo.first_name}")`));
        } catch (err) {
            console.log(c.red(`FAILED: ${err.message}`));
            throw new Error("Telegram Bot Token is invalid. Please check your token in .dev.vars");
        }

        // 2b. Notion Check
        process.stdout.write("  • Checking Notion Database Access... ");
        let notionInfo;
        try {
            notionInfo = await testNotion(env.NOTION_TOKEN, env.NOTION_DATABASE_ID);
            console.log(c.green(`OK! ("${notionInfo.title}")`));
        } catch (err) {
            console.log(c.red(`FAILED: ${err.message}`));
            console.log(c.yellow("\n💡 Tip: In Notion, open your database -> click '...' or 'Share' -> 'Add connections' -> select your integration.\n"));
            const proceed = await prompt.question("Proceed anyway? (y/N)", "N");
            if (proceed.toLowerCase() !== "y") {
                throw err;
            }
        }

        // 2c. AI Model Check
        const providerName = env.LLM_PROVIDER === "vertex" ? "Google Vertex AI" : "Google AI Studio";
        const modelName = env.VERTEX_MODEL || env.GEMINI_MODEL || "gemini-3.7-flash";
        process.stdout.write(`  • Checking ${providerName} (${modelName})... `);
        try {
            await testAI(env);
            console.log(c.green("OK!"));
        } catch (err) {
            console.log(c.yellow(`WARNING: ${err.message}`));
            console.log(c.dim("    (The worker will still be deployed; if API is disabled or undergoing quota limit, enable it in GCP Console)"));
        }

        // STEP 3: CLOUDFLARE LOGIN CHECK
        console.log(c.bold("\n[Step 3/5] ☁️  Cloudflare Authentication Check\n"));
        process.stdout.write("  • Verifying Wrangler login... ");
        try {
            const { stdout } = await execAsync("npx wrangler whoami");
            if (stdout.includes("You are logged in")) {
                console.log(c.green("Logged in!"));
            } else {
                console.log(c.yellow("Not logged in."));
                await runInteractiveWranglerLogin();
            }
        } catch (err) {
            console.log(c.yellow("Session expired or not logged in."));
            await runInteractiveWranglerLogin();
        }

        // STEP 4: SECRET UPLOAD & DEPLOYMENT
        console.log(c.bold("\n[Step 4/5] 🚀 Deploying to Cloudflare Workers\n"));

        const workerName = env.CLOUDFLARE_WORKER_NAME || getWranglerName() || "tele-expense-agent";
        updateWranglerName(workerName);

        // 4a. Upload secrets
        console.log(`  • Uploading secrets for Worker "${c.cyan(workerName)}"...`);
        try {
            await execAsync(`npx wrangler secret bulk .dev.vars --name ${workerName}`);
            console.log(c.green("    ✅ Secrets uploaded successfully."));
        } catch (err) {
            console.log(c.yellow(`    ⚠️ Secret upload notice: ${err.message || err.stderr}`));
        }

        // 4b. Deploy worker
        console.log(`  • Building and deploying Worker "${c.cyan(workerName)}"...`);
        const deployRes = await execAsync(`npx wrangler deploy --name ${workerName}`);
        console.log(c.dim(deployRes.stdout));

        // Extract worker URL
        const urlMatch = deployRes.stdout.match(/https:\/\/[a-zA-Z0-9._-]+\.workers\.dev/);
        let workerUrl = urlMatch ? urlMatch[0] : null;

        if (!workerUrl) {
            workerUrl = await prompt.question("Enter your deployed Cloudflare Worker URL", `https://${workerName}.workers.dev`);
        }

        console.log(c.green(`    ✅ Deployed URL: ${c.bold(workerUrl)}`));

        // STEP 5: AUTOMATIC TELEGRAM WEBHOOK SETUP
        console.log(c.bold("\n[Step 5/5] 🔗 Registering Telegram Webhook\n"));
        console.log(`  • Setting Webhook -> ${workerUrl}...`);

        let resolvedIp = null;
        try {
            const parsedUrl = new URL(workerUrl);
            const ips = await dns.resolve4(parsedUrl.hostname);
            if (ips && ips.length > 0) {
                resolvedIp = ips[0];
            }
        } catch (_) {}

        let whData = null;
        let lastError = "";
        const maxRetries = 6;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const body = { url: workerUrl };
                if (resolvedIp) {
                    body.ip_address = resolvedIp;
                }

                const whRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                whData = await whRes.json();
                if (whData.ok) break;
                lastError = whData.description || "Unknown error";
            } catch (err) {
                lastError = err.message;
            }

            if (attempt < maxRetries) {
                console.log(c.yellow(`    ⏳ Waiting for DNS propagation (attempt ${attempt}/${maxRetries})...`));
                await new Promise((r) => setTimeout(r, 4000));
            }
        }

        if (!whData || !whData.ok) {
            throw new Error(`Failed to set Telegram webhook: ${lastError}`);
        }
        console.log(c.green(`    ✅ Telegram Webhook registered: ${whData.description || "OK"}`));

        // Verify webhook status
        const infoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
        const infoData = await infoRes.json();
        if (infoData.ok) {
            console.log(c.dim(`    Webhook target URL: ${infoData.result.url}`));
            console.log(c.dim(`    Pending updates: ${infoData.result.pending_update_count}`));
        }

        // CELEBRATION SUMMARY
        console.log(`
${colors.green}╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🎉  ${colors.bold}TELE EXPENSE AGENT IS LIVE & READY!${colors.reset}${colors.green}                 ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝${colors.reset}

${c.bold("Summary:")}
  • ${c.cyan("Telegram Bot:")}    https://t.me/${botInfo.username}
  • ${c.cyan("Cloudflare URL:")}  ${workerUrl}
  • ${c.cyan("AI Provider:")}     ${providerName} (${modelName})
  • ${c.cyan("Notion Database:")} ${notionInfo?.title || env.NOTION_DATABASE_ID}

${c.bold("Next Steps:")}
  1. Open Telegram and start a chat with ${c.cyan("@" + botInfo.username)}
  2. Send a test expense message, for example:
     ${c.yellow('"150k cafe trứng"')} or ${c.yellow('"$12 for lunch"')}
  3. Check your Notion Database to see the automatically logged row!
  4. Stream real-time logs anytime with: ${c.cyan("npm run tail")}
`);

    } catch (err) {
        console.error(c.red(`\n❌ Setup aborted: ${err.message}\n`));
        process.exitCode = 1;
    } finally {
        prompt.close();
    }
}

main();
