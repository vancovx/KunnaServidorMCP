import { z } from "zod";
import { CampusService } from "../services/campus.service.js";
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

    // Búsqueda flexible de edificios por texto libre
    server.registerTool(
        "search-campus-buildings",
        {
            description:
                "Busca edificios del campus de la Universidad de Alicante por nombre, código SIGUA o descripción. " +
                "Entiende nombres oficiales ('Escuela Politécnica Superior I'), nombres coloquiales ('la poli', 'EPS'), " +
                "códigos SIGUA ('0016', '16') y búsquedas parciales ('ciencias', 'letras'). " +
                "Devuelve: código SIGUA, nombre oficial, plantas disponibles, coordenadas del centro y bounding box. " +
                "Usar cuando el usuario pregunta por un edificio y se necesita identificar su código SIGUA " +
                "antes de consultar datos de sensores o consumo con las herramientas get-measurements-*. " +
                "También útil para: '¿qué edificios hay?', '¿dónde está X?', 'listar edificios del campus'. " +
                "REEMPLAZA a get-measurements-sigua-codes: es más rápida (datos en memoria) y más flexible (búsqueda semántica).",
            inputSchema: z.object({
                query: z.string().describe(
                    "Texto de búsqueda. Puede ser: " +
                    "un código SIGUA ('0016', '16'), " +
                    "un nombre oficial ('Escuela Politécnica Superior I'), " +
                    "un nombre coloquial ('la poli', 'EPS', 'derecho'), " +
                    "o una búsqueda parcial ('ciencias', 'filosofía'). " +
                    "La búsqueda ignora tildes y mayúsculas."
                ),
                limit: z.number().optional().describe(
                    "Número máximo de resultados. Por defecto 5. " +
                    "Usar 1 si se busca un edificio concreto, más si la búsqueda es ambigua."
                )
            })
        },
        withLogging("search-campus-buildings", async ({ query, limit }) => {
            const results = CampusService.searchBuildings(query, limit ?? 5);

            if (results.length === 0) {
                // Si no hay resultados, devolver todos los edificios como sugerencia
                const all = CampusService.getAllBuildings();
                logger.warn({ query }, "Busqueda sin resultados, devolviendo todos los edificios");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            message: `No se ha encontrado ningun edificio que coincida con "${query}".`,
                            sugerencia: "Estos son los edificios disponibles:",
                            edificios_disponibles: all.map(b => ({
                                codigo_sigua: b.id,
                                nombre: b.nombre
                            }))
                        }, null, 2)
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        query,
                        num_resultados: results.length,
                        resultados: results.map(r => ({
                            codigo_sigua: r.building.id,
                            nombre: r.building.nombre,
                            plantas: r.building.plantas,
                            num_plantas: r.building.num_plantas,
                            centro: r.building.center,
                            bbox: r.building.bbox,
                            score: Math.round(r.score * 100) + "%",
                            tipo_match: r.matchType
                        }))
                    }, null, 2)
                }]
            };
        })
    );
}