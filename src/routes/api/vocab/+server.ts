import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { json, error } from "@sveltejs/kit";

const vocabDir = resolve(process.cwd(), "src/lib/server/vocab");

export function GET({ url }) {
    const filename = url.searchParams.get("file");

    if (!filename) {
        // List all files
        let files: string[] = [];
        try {
            files = readdirSync(vocabDir)
                .filter(f => f.endsWith(".csv"))
                .sort();
        } catch (e) {
            console.error(e);
        }
        return json({ files });
    }

    // Serve a single file
    const filePath = resolve(vocabDir, filename);
    try {
        const content = readFileSync(filePath, "utf-8");
        return new Response(content, {
            headers: { "Content-Type": "text/csv" }
        });
    } catch {
        throw error(404, "File not found");
    }
}