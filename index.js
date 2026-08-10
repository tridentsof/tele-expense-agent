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

        // Check required environment variables
        if (!env.GEMINI_API_KEY || !env.NOTION_TOKEN || !env.NOTION_DATABASE_ID || !env.TELEGRAM_BOT_TOKEN) {
            console.error("[Worker Error] Missing required environment variables!", {
                hasGeminiKey: !!env.GEMINI_API_KEY,
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

        const userPrompt = `Current time: ${currentTimeFormatted} (ISO: ${now.toISOString()})
Current date ISO: ${currentDateISO}

Message to parse: "${text}"`;

        const model = env.GEMINI_MODEL || "gemini-3.6-flash";
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        let aiResponse;

        console.log(`[Gemini API] Sending request using model "${model}"...`);

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "x-goog-api-key": env.GEMINI_API_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
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
                })
            });

            if (!res.ok) {
                const errorText = await res.text();
                console.error(`[Gemini API Error] (${res.status}):`, errorText);
                let cleanErrorMsg = `Gemini API HTTP ${res.status}`;
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
                throw new Error("Invalid Gemini API response structure (missing text part)");
            }
            aiResponse = JSON.parse(rawText);
            console.log("[Gemini API Success] Parsed output:", JSON.stringify(aiResponse));
        } catch (err) {
            console.error("[Gemini API Exception]:", err.message || err);
            const detailMsg = err.message ? `\n\n💬 Chi tiết: ${err.message}` : "";
            await sendTelegramMessage(
                env,
                chatId,
                `❌ Lỗi khi phân tích nội dung chi tiêu bằng AI.${detailMsg}`
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
        const cleanDatabaseId = rawDbId.split("?")[0].trim();

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
