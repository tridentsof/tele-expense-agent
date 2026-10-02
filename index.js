var index_default = {
    async fetch(req, env) {
        if (req.method !== "POST") {
            console.log(`[Worker] Received ${req.method} request, returning 200 OK`);
            return new Response("OK");
        }

        let update;
        try {
            update = await req.json();
        } catch (err) {
            console.error("[Worker] Failed to parse incoming JSON payload:", err);
            return new Response("OK");
        }

        const messageText = update.message?.text;
        const chatId = update.message?.chat?.id;
        const sender = update.message?.from?.username || update.message?.from?.first_name || "Unknown";

        if (!messageText || !chatId) {
            console.log("[Worker] Request ignored: payload missing message.text or chat.id");
            return new Response("No message");
        }

        console.log(`[Telegram Update] ChatId: ${chatId} | From: ${sender} | Message: "${messageText}"`);

        // Determine AI provider: 'vertex' or 'gemini' (defaults to 'vertex' if Vertex credentials are provided, otherwise 'gemini')
        const provider = (
            env.LLM_PROVIDER ||
            env.AI_PROVIDER ||
            (env.VERTEX_PROJECT_ID || env.VERTEX_SERVICE_ACCOUNT_KEY || env.VERTEX_BEARER_TOKEN ? "vertex" : "gemini")
        ).toLowerCase();

        // Check required environment variables
        const hasAiKey = provider === "vertex"
            ? !!(env.VERTEX_API_KEY || env.GEMINI_API_KEY || env.VERTEX_SERVICE_ACCOUNT_KEY || env.VERTEX_BEARER_TOKEN)
            : !!env.GEMINI_API_KEY;

        if (!hasAiKey || !env.NOTION_TOKEN || !env.NOTION_DATABASE_ID || !env.TELEGRAM_BOT_TOKEN) {
            console.error("[Worker Error] Missing required environment variables!", {
                provider,
                hasAiKey,
                hasNotionToken: !!env.NOTION_TOKEN,
                hasNotionDbId: !!env.NOTION_DATABASE_ID,
                hasTelegramToken: !!env.TELEGRAM_BOT_TOKEN
            });
            await sendTelegramMessage(env, chatId, "❌ Server configuration error: Missing environment variables.");
            return new Response("OK");
        }

        const text = messageText.trim();
        const now = new Date();
        const currentDate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate()
        );
        const currentDateISO = currentDate.toISOString();
        const currentTimeFormatted = now.toLocaleString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short"
        });

        let aiResponse;
        try {
            aiResponse = await parseExpenseWithAI(env, provider, text, currentDateISO, currentTimeFormatted);
            console.log(`[${provider.toUpperCase()} Success] Parsed output:`, JSON.stringify(aiResponse));
        } catch (err) {
            console.error(`[${provider.toUpperCase()} Exception]:`, err.message || err);
            const detailMsg = err.message ? `\n\n💬 Chi tiết: ${err.message}` : "";
            await sendTelegramMessage(
                env,
                chatId,
                `❌ Lỗi khi phân tích nội dung chi tiêu bằng AI (${provider.toUpperCase()}).${detailMsg}`
            );
            return new Response("OK");
        }

        let parsedAmount = Number(aiResponse.amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            console.log("[Worker] Invalid or missing amount in AI response, attempting fallback regex parsing...");
            const match = text.match(/(\d+[\d\.,]*)\s*(k|kđ|đ|vnd|usd|\$)?/i);
            if (match) {
                let rawVal = match[1].replace(/[\.,]/g, '');
                let val = parseFloat(rawVal);
                if (match[2] && match[2].toLowerCase() === 'k') val *= 1000;
                if (!isNaN(val) && val > 0) parsedAmount = val;
            }
        }

        if (!aiResponse.parsed || isNaN(parsedAmount) || parsedAmount <= 0) {
            console.log("[Worker] Payment details not found in message text.");
            await sendTelegramMessage(
                env,
                chatId,
                "❌ Không tìm thấy thông tin thanh toán hợp lệ trong tin nhắn."
            );
            return new Response("No payment");
        }

        const payment = {
            description: aiResponse.description || "Chi tiêu",
            date: aiResponse.date || currentDateISO,
            amount: parsedAmount,
            currency: aiResponse.currency || "VND"
        };

        // Sanitize database_id in case user pasted full URL or query parameters like ?v=...
        const rawDbId = env.NOTION_DATABASE_ID || "";
        const cleanDatabaseId = extractNotionDatabaseId(rawDbId);

        console.log(`[Notion API] Adding entry to database "${cleanDatabaseId}"...`, payment);

        try {
            const notionResponse = await fetch("https://api.notion.com/v1/pages", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${env.NOTION_TOKEN}`,
                    "Content-Type": "application/json",
                    "Notion-Version": "2022-06-28"
                },
                body: JSON.stringify({
                    parent: { database_id: cleanDatabaseId },
                    properties: {
                        description: {
                            title: [{ text: { content: payment.description || "Chi tiêu" } }]
                        },
                        amount: { number: payment.amount },
                        date: { date: { start: payment.date } },
                        currency: { rich_text: [{ text: { content: payment.currency } }] }
                    }
                })
            });

            if (!notionResponse.ok) {
                const notionError = await notionResponse.text();
                console.error(`[Notion API Error] (${notionResponse.status}):`, notionError);
                await sendTelegramMessage(
                    env,
                    chatId,
                    `❌ Lỗi khi lưu vào Notion (${notionResponse.status}). Vui lòng kiểm tra lại cấu hình Database Notion.`
                );
                return new Response("OK");
            }

            console.log("[Notion API Success] Record created successfully.");
        } catch (err) {
            console.error("[Notion API Exception]:", err.message || err);
            await sendTelegramMessage(
                env,
                chatId,
                "❌ Lỗi kết nối đến Notion API."
            );
            return new Response("OK");
        }

        const amountFormatted = payment.amount.toLocaleString("vi-VN");
        const paymentDate = new Date(payment.date);
        const formattedDate = paymentDate.toLocaleDateString("vi-VN", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric"
        });

        const replyMessage = `💰 Thanh toán: ${amountFormatted} ${payment.currency}
📝 Cho: ${payment.description || "Chi tiêu"}
📅 Ngày: ${formattedDate}

✅ Đã thêm bản ghi vào Notion thành công!`;

        await sendTelegramMessage(
            env,
            chatId,
            replyMessage
        );

        return new Response("OK");
    }
};

function extractNotionDatabaseId(rawId) {
    if (!rawId) return "";
    const clean = rawId.split("?")[0].trim();
    const parts = clean.split("/");
    const lastPart = parts[parts.length - 1];
    return lastPart.replace(/-/g, "");
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
                sa = JSON.parse(atob(saKeyInput));
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
        return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };

    const signingInput = `${b64Url(header)}.${b64Url(payload)}`;

    const pem = sa.private_key
        .replace(/-----BEGIN [A-Z ]+-----/g, "")
        .replace(/-----END [A-Z ]+-----/g, "")
        .replace(/\s+/g, "");

    const binaryDer = atob(pem);
    const derBuffer = new Uint8Array(binaryDer.length);
    for (let i = 0; i < binaryDer.length; i++) {
        derBuffer[i] = binaryDer.charCodeAt(i);
    }

    const key = await crypto.subtle.importKey(
        "pkcs8",
        derBuffer.buffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput)
    );

    const sigArray = new Uint8Array(signature);
    let sigBinary = "";
    for (let i = 0; i < sigArray.length; i++) {
        sigBinary += String.fromCharCode(sigArray[i]);
    }
    const signatureB64Url = btoa(sigBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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

async function parseExpenseWithAI(env, provider, text, currentDateISO, currentTimeFormatted) {
    const systemPrompt = `You are a strict financial transaction parser. Extract payment/expense details from user messages into a JSON object.

Output Schema:
{
  "parsed": boolean, // Set to true ONLY if payment/expense amount is identified
  "amount": number, // Numeric value of the payment (e.g. 10000 for "10000" or "10k")
  "currency": string, // ISO currency code, e.g. "VND", "USD". Default to "VND" if unspecified
  "description": string, // Item/service description prefixed with an appropriate emoji (e.g. "🍰 Mua bánh", "🥤 Nước mía"). Concise, NO reasoning text.
  "date": string // ISO 8601 date string (default to currentDateISO)
}

Rules:
- Strictly return valid JSON adhering to the schema.
- Do NOT output chain of thought or internal reasoning inside the description field.
- If user types shorthand like "10k" or "100k", convert to numeric 10000 or 100000.`;

    const userPrompt = `Current time: ${currentTimeFormatted} (ISO: ${new Date().toISOString()})
Current date ISO: ${currentDateISO}

Message to parse: "${text}"`;

    const payload = {
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [
            {
                role: "user",
                parts: [{ text: userPrompt }]
            }
        ],
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    parsed: { type: "BOOLEAN" },
                    amount: { type: "NUMBER" },
                    currency: { type: "STRING" },
                    description: { type: "STRING" },
                    date: { type: "STRING" }
                },
                required: ["parsed", "amount", "currency", "description", "date"]
            }
        }
    };

    let endpoint;
    const headers = { "Content-Type": "application/json" };
    let model;

    if (provider === "vertex") {
        let saObj = null;
        if (env.VERTEX_SERVICE_ACCOUNT_KEY) {
            try {
                saObj = typeof env.VERTEX_SERVICE_ACCOUNT_KEY === "string"
                    ? JSON.parse(env.VERTEX_SERVICE_ACCOUNT_KEY)
                    : env.VERTEX_SERVICE_ACCOUNT_KEY;
            } catch (_) {
                try {
                    saObj = JSON.parse(atob(env.VERTEX_SERVICE_ACCOUNT_KEY));
                } catch (e) {}
            }
        }

        const projectId = env.VERTEX_PROJECT_ID || saObj?.project_id;
        const region = env.VERTEX_REGION || env.VERTEX_LOCATION || "us-central1";
        model = env.VERTEX_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash";

        if (projectId) {
            // Google Cloud Vertex AI Regional Endpoint
            endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
        } else {
            // Vertex AI Express Mode Endpoint
            endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`;
        }

        if (env.VERTEX_SERVICE_ACCOUNT_KEY) {
            const token = await getGoogleOAuthToken(env.VERTEX_SERVICE_ACCOUNT_KEY);
            headers["Authorization"] = `Bearer ${token}`;
        } else if (env.VERTEX_BEARER_TOKEN) {
            headers["Authorization"] = `Bearer ${env.VERTEX_BEARER_TOKEN}`;
        } else {
            const apiKey = env.VERTEX_API_KEY || env.GEMINI_API_KEY;
            if (!apiKey) {
                throw new Error("Missing Vertex AI credentials (VERTEX_SERVICE_ACCOUNT_KEY, VERTEX_API_KEY, or GEMINI_API_KEY)");
            }
            headers["x-goog-api-key"] = apiKey;
            endpoint += (endpoint.includes("?") ? "&" : "?") + `key=${encodeURIComponent(apiKey)}`;
        }

        console.log(`[Vertex AI] Calling model "${model}"...`);
    } else {
        // Google AI Studio Gemini API
        model = env.GEMINI_MODEL || "gemini-2.5-flash";
        endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error("Missing GEMINI_API_KEY for Gemini AI Studio");
        }
        headers["x-goog-api-key"] = apiKey;

        console.log(`[Gemini API] Calling model "${model}"...`);
    }

    let res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
    });

    // Auto-fallback if the specified model is not available in the region
    if (!res.ok && res.status === 404 && provider === "vertex" && model !== "gemini-2.5-flash") {
        const projectId = env.VERTEX_PROJECT_ID || "video-teaching-research";
        const region = env.VERTEX_REGION || env.VERTEX_LOCATION || "us-central1";
        console.warn(`[Vertex AI] Model "${model}" returned 404, falling back to "gemini-2.5-flash"...`);
        model = "gemini-2.5-flash";
        endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
        res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });
    }

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`[${provider.toUpperCase()} API Error] (${res.status}):`, errorText);
        let cleanErrorMsg = `${provider === "vertex" ? "Vertex AI" : "Gemini API"} HTTP ${res.status}`;
        try {
            const parsedObj = JSON.parse(errorText);
            if (parsedObj.error?.message) {
                cleanErrorMsg = parsedObj.error.message;
            }
        } catch (_) {
            if (errorText) cleanErrorMsg = errorText;
        }
        throw new Error(cleanErrorMsg);
    }

    const json = await res.json();
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
        throw new Error(`Invalid response from ${provider} API (missing text part in candidates)`);
    }
    return JSON.parse(rawText);
}

async function sendTelegramMessage(env, chatId, text) {
    const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    console.log(`[Telegram API] Sending message to chatId ${chatId}...`);
    try {
        const response = await fetch(telegramUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Telegram API Error] (${response.status}):`, errorText);
        } else {
            console.log("[Telegram API Success] Message sent.");
        }
    } catch (err) {
        console.error("[Telegram API Exception]:", err.message || err);
        throw err;
    }
}

export {
    index_default as default
};
