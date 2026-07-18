import { pipeline, env } from '@xenova/transformers';

env.cacheDir = './models';
env.allowRemoteModels = true;

console.error('Descargando modelo (~1 GB, puede tardar)...');
await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2');
console.error('OK: modelo guardado en ./models');
process.exit(0);