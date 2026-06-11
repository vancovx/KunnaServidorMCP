import { z } from "zod";
import { EmbeddingsService } from "../services/embeddings.service.js";
import logger from "../config/logger.js";

// Wrapper de logging reutilizable (igual que en registerTool.js)
function withLogging(name, handler) {
    return async (params) => {
        const start = Date.now();
        logger.info({ tool: name, params }, "Tool invocada");
        try {
            const result = await handler(params);
            logger.info({ tool: name, ms: Date.now() - start }, "Tool completada");
            return result;
        } catch (err) {
            logger.error({ tool: name, err }, "Tool fallida");
            throw err;
        }
    };
}

// Extrae un codigo SIGUA de la query si lo hay: "0014", "14", "edificio 14", "sigua 0014".
// Devuelve el codigo normalizado a 4 digitos o null.
function extractSiguaCode(query) {
    const normalized = query
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const digits = normalized.replace(/\s/g, "");
    if (/^\d{1,4}$/.test(digits)) return digits.padStart(4, "0");

    const match = normalized.match(/(?:edificio|sigua|codigo)\s*(\d{1,4})/);
    if (match) return match[1].padStart(4, "0");

    return null;
}

export function registerCampusTools(server) {

    // Búsqueda flexible de edificios:
    //   1) Si la query es un código SIGUA o lo contiene -> match directo en memoria.
    //   2) Si no -> búsqueda semántica con embeddings sobre la tabla `buildings`.
    server.registerTool(
        "search-campus-buildings",
        {
            description:
                "Busca edificios del campus de la Universidad de Alicante por código SIGUA o por descripción en lenguaje natural. " +
                "Si la consulta es un código SIGUA ('0016', '16', 'edificio 14'), resuelve directamente al edificio. " +
                "En cualquier otro caso (nombres oficiales, coloquiales, descripciones, usos: 'la poli', 'derecho', 'donde se imparte enfermería'), " +
                "usa búsqueda semántica por embeddings para encontrar los edificios más relevantes. " +
                "Devuelve: código SIGUA, nombre oficial, plantas disponibles, coordenadas del centro y bounding box. " +
                "Usar cuando el usuario pregunta por un edificio y se necesita identificar su código SIGUA " +
                "antes de consultar datos de sensores o consumo con las herramientas get-measurements-*. " +
                "También útil para: '¿qué edificios hay?', '¿dónde está X?', 'listar edificios del campus'.",
            inputSchema: z.object({
                query: z.string().describe(
                    "Texto de búsqueda. Puede ser: " +
                    "un código SIGUA ('0016', '16', 'edificio 14'), " +
                    "un nombre oficial ('Escuela Politécnica Superior I'), " +
                    "un nombre coloquial ('la poli', 'EPS', 'derecho'), " +
                    "o una descripción libre ('donde se imparte informática', 'la facultad de ciencias'). " +
                    "La búsqueda ignora tildes y mayúsculas."
                ),
                limit: z.number().optional().describe(
                    "Número máximo de resultados para la búsqueda semántica. Por defecto 5. " +
                    "Usar 1 si se busca un edificio concreto, más si la búsqueda es ambigua. " +
                    "Ignorado cuando la query es un código SIGUA (devuelve un único resultado)."
                )
            })
        },
        withLogging("search-campus-buildings", async ({ query, limit }) => {
            const maxResults = limit ?? 5;

            // 1. Intento por codigo SIGUA (lookup exacto en BD)
            const sigua = extractSiguaCode(query);
            if (sigua) {
                const b = await EmbeddingsService.getBuildingBySigua(sigua);
                if (b) {
                    return { content: [{ type: "text", text: JSON.stringify({
                        query,
                        num_resultados: 1,
                        tipo_busqueda: "codigo_sigua",
                        resultados: [{
                            codigo_sigua: b.sigua,
                            nombre: b.nombre,
                            plantas: b.plantas,
                            num_plantas: b.plantas?.length ?? 0,
                            centro: { lat: b.center_lat, lon: b.center_lon },
                            score: "100%",
                            tipo_match: "exact_code"
                        }]
                    }, null, 2) }] };
                }
                // Si el codigo no existe, caemos a la busqueda semantica igualmente
            }

            // 2. Busqueda semantica
            const semanticResults = await EmbeddingsService.findRelevantBuildings(query, maxResults, 0.3);

            if (semanticResults.length === 0) {
                const all = await EmbeddingsService.getAllBuildings();
                logger.warn({ query }, "Busqueda semantica sin resultados, devolviendo listado");
                return { content: [{ type: "text", text: JSON.stringify({
                    message: `No se ha encontrado ningun edificio que coincida con "${query}".`,
                    sugerencia: "Estos son los edificios disponibles:",
                    edificios_disponibles: all.map(b => ({ codigo_sigua: b.sigua, nombre: b.nombre }))
                }, null, 2) }] };
            }

            return { content: [{ type: "text", text: JSON.stringify({
                query,
                num_resultados: semanticResults.length,
                tipo_busqueda: "semantica",
                resultados: semanticResults.map(r => ({
                    codigo_sigua: r.sigua,
                    nombre: r.nombre,
                    plantas: r.plantas ?? [],
                    num_plantas: r.plantas?.length ?? 0,
                    centro: { lat: r.center_lat, lon: r.center_lon },
                    score: Math.round(r.similarity * 100) + "%",
                    tipo_match: "semantic"
                }))
            }, null, 2) }] };
        })
    );
}