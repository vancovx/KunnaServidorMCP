import { z } from "zod";
import { CampusService } from "../services/campus.service.js";
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

            // 1. Intento por código SIGUA 
            const codeMatch = CampusService.matchByCode(query);
            if (codeMatch) {
                logger.debug({ query, id: codeMatch.id }, "Match directo por codigo SIGUA");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            query,
                            num_resultados: 1,
                            tipo_busqueda: "codigo_sigua",
                            resultados: [{
                                codigo_sigua: codeMatch.id,
                                nombre: codeMatch.nombre,
                                plantas: codeMatch.plantas,
                                num_plantas: codeMatch.num_plantas,
                                centro: codeMatch.center,
                                bbox: codeMatch.bbox,
                                score: "100%",
                                tipo_match: "exact_code"
                            }]
                        }, null, 2)
                    }]
                };
            }

            // 2. Búsqueda semántica por embeddings 
            const semanticResults = await EmbeddingsService.findRelevantBuildings(query, maxResults, 0.3);

            if (semanticResults.length === 0) {
                // Sin matches semánticos: devolver el listado completo como sugerencia
                const all = CampusService.getAllBuildings();
                logger.warn({ query }, "Busqueda semantica sin resultados, devolviendo todos los edificios");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            message: `No se ha encontrado ningún edificio que coincida con "${query}".`,
                            sugerencia: "Estos son los edificios disponibles:",
                            edificios_disponibles: all.map(b => ({
                                codigo_sigua: b.id,
                                nombre: b.nombre
                            }))
                        }, null, 2)
                    }]
                };
            }

            // Enriquecer los resultados semánticos con datos en memoria (bbox, plantas, etc.)
            const enriched = semanticResults.map(r => {
                const inMemory = CampusService.getBuildingById(r.sigua);
                return {
                    codigo_sigua: r.sigua,
                    nombre: r.nombre,
                    plantas: inMemory?.plantas ?? r.plantas ?? [],
                    num_plantas: inMemory?.num_plantas ?? (r.plantas?.length ?? 0),
                    centro: inMemory?.center ?? { lat: r.center_lat, lon: r.center_lon },
                    bbox: inMemory?.bbox ?? null,
                    score: Math.round(r.similarity * 100) + "%",
                    tipo_match: "semantic"
                };
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        query,
                        num_resultados: enriched.length,
                        tipo_busqueda: "semantica",
                        resultados: enriched
                    }, null, 2)
                }]
            };
        })
    );
}