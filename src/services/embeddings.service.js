// src/services/embeddings.service.js
import { pipeline } from '@xenova/transformers';
import pg from 'pg';
import dotenv from 'dotenv';
import { join } from 'path';
import { readFile } from 'fs/promises';

dotenv.config({ path: join(process.cwd(), 'config/.env'), quiet: true });

// ─────────────────────────────────────────────────────────────────────────────
//  Modelo singleton — se carga una sola vez en toda la vida del proceso
// ─────────────────────────────────────────────────────────────────────────────
let embedder = null;

async function getEmbedder() {
    if (!embedder) {
        console.error('[Embeddings] Cargando modelo paraphrase-multilingual-mpnet-base-v2...');
        embedder = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2');
        console.error('[Embeddings] Modelo cargado');
    }
    return embedder;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pool de PostgreSQL singleton
// ─────────────────────────────────────────────────────────────────────────────
let pool = null;

function getPool() {
    if (!pool) {
        pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    }
    return pool;
}

// ─────────────────────────────────────────────────────────────────────────────
//  API pública del servicio
// ─────────────────────────────────────────────────────────────────────────────
export const EmbeddingsService = {

    // ═══════════════════════════════════════════════════════════════════════
    //  GENÉRICO
    // ═══════════════════════════════════════════════════════════════════════

    // Genera un embedding para cualquier texto (vector de 768 dimensiones).
    async generate(text) {
        const model = await getEmbedder();
        const output = await model(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  MCP TOOLS
    // ═══════════════════════════════════════════════════════════════════════

    // Lee las herramientas de la BD, genera su embedding (nombre + descripción)
    // y lo guarda en la columna `embedding` de mcp_tools.
    async generateAndSaveAllTools(force = false) {
        const client = await getPool().connect();

        try {
            console.error('[Embeddings/Tools] Leyendo herramientas de la BD...');

            const { rows: tools } = await client.query(
                force
                    ? `SELECT nombre, descripcion FROM mcp_tools`
                    : `SELECT nombre, descripcion FROM mcp_tools WHERE embedding IS NULL`
            );

            if (tools.length === 0) {
                console.error('[Embeddings/Tools] No hay herramientas pendientes de embedding.');
                return;
            }

            console.error(`[Embeddings/Tools] ${tools.length} herramienta(s) a procesar.`);

            for (const tool of tools) {
                const text = `${tool.nombre}: ${tool.descripcion}`;

                console.error(`[Embeddings/Tools] Procesando: ${tool.nombre}`);
                const vector = await this.generate(text);
                const vectorLiteral = `[${vector.join(',')}]`;

                await client.query(
                    `UPDATE mcp_tools
                     SET embedding = $1::vector
                     WHERE nombre = $2`,
                    [vectorLiteral, tool.nombre]
                );

                console.error(`[Embeddings/Tools]   ✓ ${tool.nombre}`);
            }

            console.error('[Embeddings/Tools] Proceso completado.');
        } finally {
            client.release();
        }
    },

    // Busca las N herramientas más similares a la query del usuario.
    async findRelevantTools(userQuery, topK = 3, threshold = 0.4) {
        const vector = await this.generate(userQuery);
        const vectorLiteral = `[${vector.join(',')}]`;

        const { rows } = await getPool().query(
            `SELECT
                nombre,
                descripcion,
                categoria,
                parametros,
                1 - (embedding <=> $1::vector) AS similarity
             FROM mcp_tools
             WHERE embedding IS NOT NULL
               AND 1 - (embedding <=> $1::vector) > $2
             ORDER BY similarity DESC
             LIMIT $3`,
            [vectorLiteral, threshold, topK]
        );

        return rows;
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  BUILDINGS (edificios de la UA)
    // ═══════════════════════════════════════════════════════════════════════

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