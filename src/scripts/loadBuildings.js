import { join } from 'path';
import { EmbeddingsService } from '../services/embeddings.service.js';

console.error('DATABASE_URL:', process.env.DATABASE_URL);

async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const jsonArg = args.find(a => !a.startsWith('--'));

    const jsonPath = jsonArg
        ? join(process.cwd(), jsonArg)
        : join(process.cwd(), 'data/edificios.json');

    console.error(`[loadBuildings] Cargando: ${jsonPath}`);
    console.error(`[loadBuildings] Force regen: ${force}`);

    await EmbeddingsService.loadBuildingsFromJsonFile(jsonPath, { force });

    console.error('[loadBuildings] ✅ Hecho.');
    process.exit(0);
}

main().catch((err) => {
    console.error('[loadBuildings] ❌ Error:', err);
    process.exit(1);
});