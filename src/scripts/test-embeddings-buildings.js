import 'dotenv/config';
import { EmbeddingsService } from '../services/embeddings.service.js';

const queries = [
    "la facultad de derecho",
    "donde se imparte informática",
    "el edificio de la poli",
    "ciencias 3",
    "arqui",
    "informatica",
];

for (const q of queries) {
    console.error(`\n🔎 Query: "${q}"`);
    const results = await EmbeddingsService.findRelevantBuildings(q, 5, 0.3);
    if (results.length === 0) {
        console.error('   (sin resultados sobre el umbral)');
        continue;
    }
    for (const r of results) {
        console.error(`  [${(r.similarity * 100).toFixed(1)}%] ${r.sigua} — ${r.nombre}`);
    }
}

process.exit(0);