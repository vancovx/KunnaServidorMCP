import 'dotenv/config';
import { EmbeddingsService } from '../services/embeddings.service.js';

// Pasa --force para regenerar embeddings aunque ya existan
const force = process.argv.includes('--force');

if (force) {
    console.error('[Embeddings] Modo force: se regenerarán todos los embeddings.');
}

EmbeddingsService.generateAndSaveAll(force)
    .then(() => process.exit(0))
    .catch(err => {
        console.error('[Embeddings] Error:', err);
        process.exit(1);
    });