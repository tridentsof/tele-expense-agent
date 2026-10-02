import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const devVarsPath = path.join(rootDir, ".dev.vars");

export function syncServiceAccountEnv() {
    if (!fs.existsSync(devVarsPath)) return;

    let content = fs.readFileSync(devVarsPath, "utf-8");
    const lines = content.split("\n");
    let saPath = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith("VERTEX_SERVICE_ACCOUNT_PATH=")) {
            saPath = line.slice("VERTEX_SERVICE_ACCOUNT_PATH=".length).trim();
            if ((saPath.startsWith('"') && saPath.endsWith('"')) || (saPath.startsWith("'") && saPath.endsWith("'"))) {
                saPath = saPath.slice(1, -1);
            }
        }
    }

    // Default to gcp-service-account.json if not set but file exists
    if (!saPath && fs.existsSync(path.join(rootDir, "gcp-service-account.json"))) {
        saPath = "gcp-service-account.json";
    }

    if (!saPath) return;

    const fullPath = path.isAbsolute(saPath) ? saPath : path.resolve(rootDir, saPath);
    if (!fs.existsSync(fullPath)) {
        console.warn(`[Sync Env] Notice: Service account file not found at ${fullPath}`);
        return;
    }

    try {
        const rawJson = fs.readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(rawJson);
        const base64Key = Buffer.from(rawJson).toString("base64");

        let updated = false;
        const newLines = [];
        let hasSaPathLine = false;
        let hasSaKeyLine = false;
        let hasProjectIdLine = false;

        for (const rawLine of lines) {
            let line = rawLine;
            if (line.startsWith("VERTEX_SERVICE_ACCOUNT_PATH=")) {
                line = `VERTEX_SERVICE_ACCOUNT_PATH=${saPath}`;
                hasSaPathLine = true;
            } else if (line.startsWith("VERTEX_SERVICE_ACCOUNT_KEY=")) {
                line = `VERTEX_SERVICE_ACCOUNT_KEY=${base64Key}`;
                hasSaKeyLine = true;
                updated = true;
            } else if (line.startsWith("VERTEX_PROJECT_ID=") && parsed.project_id) {
                line = `VERTEX_PROJECT_ID=${parsed.project_id}`;
                hasProjectIdLine = true;
            }
            newLines.push(line);
        }

        if (!hasSaPathLine) {
            newLines.push(`VERTEX_SERVICE_ACCOUNT_PATH=${saPath}`);
            updated = true;
        }
        if (!hasSaKeyLine) {
            newLines.push(`VERTEX_SERVICE_ACCOUNT_KEY=${base64Key}`);
            updated = true;
        }
        if (!hasProjectIdLine && parsed.project_id) {
            newLines.push(`VERTEX_PROJECT_ID=${parsed.project_id}`);
            updated = true;
        }

        fs.writeFileSync(devVarsPath, newLines.join("\n"), "utf-8");
        console.log(`[Sync Env] Synchronized service account from ${saPath} into .dev.vars`);
    } catch (err) {
        console.warn(`[Sync Env] Error syncing service account from ${fullPath}:`, err.message);
    }
}

// Run directly if called as a script
if (process.argv[1] === __filename) {
    syncServiceAccountEnv();
}
