// scripts/mergeBuildings.js
import { readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const INPUT_DIR = join(process.cwd(), "data/buildings");
const OUTPUT_FILE = join(process.cwd(), "data/edificios.json");

const files = (await readdir(INPUT_DIR)).filter(f => f.endsWith(".json"));

const edificios = [];

for (const file of files) {
    const raw = await readFile(join(INPUT_DIR, file), "utf-8");
    const geojson = JSON.parse(raw);
    const props = geojson.features?.[0]?.properties;

    if (!props?.id) continue;

    const bbox = props.bbox.split(",").map(Number);
    const plantas = props.plantas.replace(/[{}]/g, "").split(",").filter(Boolean);

    edificios.push({
        sigua: props.id,
        nombre: props.nombre,
        plantas,
        center: {
            lon: (bbox[0] + bbox[2]) / 2,
            lat: (bbox[1] + bbox[3]) / 2,
        }
    });
}

await writeFile(OUTPUT_FILE, JSON.stringify(edificios, null, 2), "utf-8");
console.log(`✓ ${edificios.length} edificios guardados en edificios.json`);