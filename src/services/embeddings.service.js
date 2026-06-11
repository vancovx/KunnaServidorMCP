// src/services/embeddings.service.js
import { pipeline } from '@xenova/transformers';
import pg from 'pg';
import { readFile } from 'fs/promises';

//  Modelo singleton — se carga una sola vez en toda la vida del proceso
let embedder = null;

async function getEmbedder() {
    if (!embedder) {
        console.error('[Embeddings] Cargando modelo paraphrase-multilingual-mpnet-base-v2...');
        embedder = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2');
        console.error('[Embeddings] Modelo cargado');
    }
    return embedder;
}


//  Pool de PostgreSQL singleton
let pool = null;

function getPool() {
    if (!pool) {
        pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    }
    return pool;
}

//  API pública del servicio
export const EmbeddingsService = {

    // Genera un embedding para cualquier texto (vector de 768 dimensiones).
    async generate(text) {
        const model = await getEmbedder();
        const output = await model(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    },

    //  BUILDINGS (edificios de la UA)
    // Obtiene un edificio por su codigo SIGUA exacto.
    async getBuildingBySigua(sigua) {
        const { rows } = await getPool().query(
            `SELECT sigua, nombre, plantas, center_lat, center_lon
            FROM buildings
            WHERE sigua = $1`,
            [sigua]
        );
        return rows[0] ?? null;
    },

    // Lista todos los edificios (para listados y sugerencias).
    async getAllBuildings() {
        const { rows } = await getPool().query(
            `SELECT sigua, nombre, plantas, center_lat, center_lon
            FROM buildings
            ORDER BY sigua`
        );
        return rows;
    },


    // Inserta o actualiza un array de edificios (sin generar embedding todavía).
    async upsertBuildings(buildings) {
        const client = await getPool().connect();
        try {
            console.error(`[Embeddings/Buildings] Insertando ${buildings.length} edificios...`);

            for (const b of buildings) {
                const plantas   = Array.isArray(b.plantas) ? b.plantas : [];
                const centerLat = b.center?.lat ?? null;
                const centerLon = b.center?.lon ?? null;

                await client.query(
                    `INSERT INTO buildings
                        (sigua, nombre, description_embedding, plantas, center_lat, center_lon)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (sigua) DO UPDATE
                       SET nombre                = EXCLUDED.nombre,
                           description_embedding = EXCLUDED.description_embedding,
                           plantas               = EXCLUDED.plantas,
                           center_lat            = EXCLUDED.center_lat,
                           center_lon            = EXCLUDED.center_lon`,
                    [b.sigua, b.nombre, b.description_embedding, plantas, centerLat, centerLon]
                );
                console.error(`[Embeddings/Buildings]   ✓ ${b.sigua} — ${b.nombre}`);
            }

            console.error('[Embeddings/Buildings] Inserción completada.');
        } finally {
            client.release();
        }
    },

    // Lee los edificios de la BD, genera el embedding (nombre + descripción)
    // y lo guarda en la columna `embedding` de buildings.
    async generateAndSaveAllBuildings(force = false) {
        const client = await getPool().connect();

        try {
            console.error('[Embeddings/Buildings] Leyendo edificios de la BD...');

            const { rows: buildings } = await client.query(
                force
                    ? `SELECT sigua, nombre, description_embedding FROM buildings`
                    : `SELECT sigua, nombre, description_embedding
                       FROM buildings
                       WHERE embedding IS NULL`
            );

            if (buildings.length === 0) {
                console.error('[Embeddings/Buildings] No hay edificios pendientes de embedding.');
                return;
            }

            console.error(`[Embeddings/Buildings] ${buildings.length} edificio(s) a procesar.`);

            for (const b of buildings) {
                // Combinamos nombre + descripción para enriquecer el vector.
                const text = `${b.nombre}. ${b.description_embedding}`;

                console.error(`[Embeddings/Buildings] Procesando: ${b.sigua} — ${b.nombre}`);

                const vector = await this.generate(text);
                const vectorLiteral = `[${vector.join(',')}]`;

                await client.query(
                    `UPDATE buildings
                     SET embedding = $1::vector
                     WHERE sigua = $2`,
                    [vectorLiteral, b.sigua]
                );

                console.error(`[Embeddings/Buildings]   ✓ ${b.sigua}`);
            }

            console.error('[Embeddings/Buildings] Embeddings generados correctamente.');
        } finally {
            client.release();
        }
    },

    // Atajo: lee un JSON de edificios desde disco y hace upsert + embeddings.
    async loadBuildingsFromJsonFile(jsonPath, { force = false } = {}) {
        const raw = await readFile(jsonPath, 'utf-8');
        const buildings = JSON.parse(raw);

        await this.upsertBuildings(buildings);
        await this.generateAndSaveAllBuildings(force);
    },

    // Busca los N edificios más similares a una consulta en lenguaje natural.
    // Útil para resolver referencias tipo "el aulario grande",
    // "el edificio donde se imparte enfermería", etc.
    async findRelevantBuildings(userQuery, topK = 5, threshold = 0.3) {
        const vector = await this.generate(userQuery);
        const vectorLiteral = `[${vector.join(',')}]`;

        const { rows } = await getPool().query(
            `SELECT
                sigua,
                nombre,
                description_embedding,
                plantas,
                center_lat,
                center_lon,
                1 - (embedding <=> $1::vector) AS similarity
             FROM buildings
             WHERE embedding IS NOT NULL
               AND 1 - (embedding <=> $1::vector) > $2
             ORDER BY similarity DESC
             LIMIT $3`,
            [vectorLiteral, threshold, topK]
        );

        return rows;
    },
};