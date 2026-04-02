import { readdirSync } from "fs";
import { resolve } from "path";

export async function load() {
    const dir = resolve(process.cwd(), "src/lib/server/vocab");

    let serverFiles: string[] = [];

    try {
        serverFiles = readdirSync(dir)
            .filter((f) => f.endsWith(".csv"))
            .sort();
    } catch (e) {
        console.log("ERROR:", e);
    }

    console.log("DIR:", dir);
    console.log("FILES:", serverFiles);

    return { serverFiles };
}