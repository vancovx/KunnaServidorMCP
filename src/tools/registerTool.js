import { z } from "zod";
import { OpenApiMeasurements } from "../services/measurements.service.js";
import logger from "../config/logger.js";



// Schema reutilizable: colecciones IoT
const collectionEnum = z.enum([
    "bim",
    "water",
    "energy",
    "weather",
    "sensotran",
    "roomsensors",
    "light",
    "fv",
    "irrigation",
    "bibliotecaindoorambiental",
    "wifi",
    "gva_weather",
]).describe(
    `Colección de datos IoT a consultar. Selecciona según el tipo de consulta del usuario:\n` +

    `- 'bim': Sensores IoT de suelo Dragino LSE01 en jardines del campus y caudalímetro CZUS/50. ` +
        `Miden humedad del suelo, temperatura del suelo y conductividad eléctrica (tecnología FDR con compensación por temperatura y calibración de fábrica para suelos minerales). ` +
        `Usar cuando pregunten por: estado del suelo, humedad de tierra, jardines inteligentes, conductividad del terreno, sensores de suelo, caudalímetro.\n` +

    `- 'water': Consumo de agua potable en edificios del campus. ` +
        `Usar cuando pregunten por: litros, m³, consumo de agua, gasto hídrico, fugas de agua, contadores de agua, agua potable.\n` +

    `- 'energy': Consumo eléctrico de edificios y zonas comunes del campus de la Universidad de Alicante (kWh). ` +
        `Usar cuando pregunten por: electricidad, consumo eléctrico, kilovatios, potencia eléctrica, factura de luz, contadores eléctricos.\n` +

    `- 'weather': Estación meteorológica propia instalada en el campus de la Universidad de Alicante. ` +
        `Usar cuando pregunten por: temperatura exterior del campus, viento en la universidad, lluvia en el campus, humedad ambiente, presión atmosférica, clima del campus.\n` +

    `- 'sensotran': Sensores de prevención y seguridad de gases. ` +
        `Miden concentraciones de monóxido de carbono (CO), hidrógeno (H₂), compuestos orgánicos volátiles (VOC) y gases inflamables. ` +
        `Objetivo: evaluar seguridad, detectar fugas y validar el sistema antes de despliegue definitivo. ` +
        `Usar cuando pregunten por: detección de gases, fugas de gas, seguridad de gases, CO, hidrógeno, VOC exterior, gases inflamables.\n` +

    `- 'roomsensors': Calidad ambiental interior de salas, aulas y despachos. ` +
        `Miden CO2, temperatura interior, humedad interior y VOC. ` +
        `Usar cuando pregunten por: CO2 en aulas, temperatura de una sala, humedad dentro de un edificio, calidad del aire interior, confort térmico, ventilación de salas.\n` +

    `- 'light': Luminarias de exterior instaladas en el campus universitario. ` +
        `Usar cuando pregunten por: farolas, alumbrado exterior, iluminación del campus, luminarias, luces exteriores.\n` +

    `- 'fv': Producción solar fotovoltaica de la Universidad de Alicante. ` +
        `Usar cuando pregunten por: paneles solares, producción solar, energía renovable, autoconsumo, fotovoltaica, generación solar.\n` +

    `- 'irrigation': Gestión de agua de riego de jardines y zonas verdes del campus. ` +
        `Usar cuando pregunten por: riego, aspersores, agua de riego, zonas verdes, jardines, programación de riego.\n` +

    `- 'bibliotecaindoorambiental': Sensores ambientales interiores específicos de la Biblioteca General. ` +
        `Usar cuando pregunten por: ambiente en la biblioteca, temperatura de la biblioteca, CO2 en la biblioteca, humedad en la biblioteca. ` +
        `NOTA: si preguntan por calidad ambiental de OTROS edificios, usar 'roomsensors' en su lugar.\n` +

    `- 'wifi': Datos de conectividad WiFi del campus. ` +
        `Usar cuando pregunten por: conexiones WiFi, usuarios conectados, cobertura WiFi, red inalámbrica, puntos de acceso, tráfico de red.\n` +

    `- 'gva_weather': Datos meteorológicos de la API de la Generalitat Valenciana (red de estaciones AVAMET/AEMET). ` +
        `Usar cuando pregunten por: meteorología regional, clima de la Comunidad Valenciana, estaciones meteorológicas de la GVA, comparar clima campus vs región. ` +
        `NOTA: si pregunten por meteorología específica del campus, usar 'weather' en su lugar.`
);

// ─────────────────────────────────────────────────────────────────────────────
//  Definición completa de las 4 tools
//  Cada entrada: { name, definition, handler }
// ─────────────────────────────────────────────────────────────────────────────
const ALL_TOOLS = [

    // ─── 1. DISCOVER-COLLECTION ──────────────────────────────────────────────
    {
        name: "discover-collection",
        definition: {
            description:
                "Devuelve toda la información de una colección IoT en una sola llamada: " +
                "descripción general, lista de dispositivos (con IDs y alias) y magnitudes disponibles. " +
                "Usar como PRIMER PASO para cualquier consulta: " +
                "'¿qué datos hay?', '¿qué sensores existen?', '¿qué mide esta colección?', " +
                "'¿qué dispositivos hay en energía?', '¿qué magnitudes tiene el sensor X?'. " +
                "También útil para obtener IDs de dispositivos antes de consultar datos con query-data o query-aggregation.",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().optional().describe(
                    "ID de un dispositivo concreto para filtrar sus magnitudes. " +
                    "Si se omite, devuelve las magnitudes de toda la colección."
                )
            })
        },
        handler: async ({ collection, device_id }) => {
            if (device_id) {
                // Si hay device_id → solo info general + magnitudes de ese dispositivo
                const [info, magnitudes] = await Promise.all([
                    OpenApiMeasurements.fetchOpenApiInfo(collection),
                    OpenApiMeasurements.fetchOpenApiMagnitudes(collection, device_id)
                ]);
                return {
                    content: [{ type: "text", text: JSON.stringify({ collection_info: info, magnitudes }, null, 2) }]
                };
            }

            // Sin device_id → todo: info + lista de dispositivos + todas las magnitudes
            const [info, devices, magnitudes] = await Promise.all([
                OpenApiMeasurements.fetchOpenApiInfo(collection),
                OpenApiMeasurements.fetchOpenApiDevices(collection),
                OpenApiMeasurements.fetchOpenApiMagnitudes(collection)
            ]);
            return {
                content: [{ type: "text", text: JSON.stringify({ collection_info: info, devices, magnitudes }, null, 2) }]
            };
        }
    },

    // ─── 2. GET-DEVICE-DETAILS ───────────────────────────────────────────────
    {
        name: "get-device-details",
        definition: {
            description:
                "Devuelve los detalles completos de un dispositivo específico: " +
                "nombre, alias, geolocalización (lat/lon), ubicación dentro del edificio, " +
                "organización, tipo de métrica, código SIGUA del edificio y campos personalizados. " +
                "Usar cuando el usuario pregunta: '¿dónde está este sensor?', '¿qué es el dispositivo X?', " +
                "'información del contador', 'ubicación del equipo', 'detalles del sensor'. " +
                "Requiere el device_id, que se obtiene de discover-collection.",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().describe(
                    "ID del dispositivo del que se quieren obtener los detalles. " +
                    "Se obtiene de discover-collection."
                )
            })
        },
        handler: async ({ collection, device_id }) => {
            const result = await OpenApiMeasurements.fetchOpenApiMetadaDevice(collection, device_id);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
    },

    // ─── 3. QUERY-DATA ───────────────────────────────────────────────────────
    {
        name: "query-data",
        definition: {
            description:
                "Consulta datos CRUDOS de mediciones en series temporales. " +
                "Devuelve cada lectura individual con su timestamp, valor y unidad. " +
                "Usar cuando el usuario necesita: valores exactos, datos sin procesar, " +
                "exportar lecturas, ver cada medición individual, detectar valores puntuales. " +
                "Para obtener estadísticas (media, máximo, mínimo) o evolución por horas/días, " +
                "usar query-aggregation en su lugar, que es más eficiente. " +
                "El rango temporal se define con start/end (fechas absolutas) o last (minutos hacia atrás).",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().optional().describe(
                    "ID del dispositivo a filtrar. Sin este parámetro, devuelve datos de todos los dispositivos."
                ),
                magnitude: z.string().optional().describe(
                    "Magnitud a filtrar (ej: 'temperature', 'humidity', 'co2', 'generalelectricity'). " +
                    "Usar discover-collection para ver las magnitudes disponibles."
                ),
                tags: z.array(z.object({
                    field: z.string().describe("Campo del tag por el que filtrar."),
                    values: z.array(z.string()).describe("Valores del tag. Múltiples valores se evalúan con OR.")
                })).optional().describe("Filtros adicionales por tags. Múltiples objetos tag se combinan con AND."),
                start: z.string().optional().describe("Fecha de inicio en ISO 8601. Usar junto con 'end'."),
                end: z.string().optional().describe("Fecha de fin en ISO 8601. Usar junto con 'start'."),
                last: z.number().optional().describe(
                    "Minutos hacia atrás desde ahora. Ej: 60 = última hora, 1440 = último día. Por defecto 60."
                ),
                timezone: z.string().optional().describe("Zona horaria. Por defecto 'Europe/Madrid'."),
                limit: z.number().optional().describe("Número máximo de resultados. Por defecto 1000."),
                include_metadata: z.boolean().optional().describe("Si true, incluye metadatos del dispositivo. Por defecto false."),
                export_format: z.enum(["json", "csv", "xml"]).optional().describe("Formato de exportación. Por defecto 'json'.")
            })
        },
        handler: async (params = {}) => {
            const result = await OpenApiMeasurements.fetchOpenApiQueryData(params);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
    },

    // ─── 4. QUERY-AGGREGATION ────────────────────────────────────────────────
    {
        name: "query-aggregation",
        definition: {
            description:
                "Consulta datos AGREGADOS de mediciones agrupados por intervalos de tiempo. " +
                "Aplica funciones estadísticas (media, mínimo, máximo, suma, cuenta, último valor) " +
                "sobre los datos agrupados en intervalos configurables (por hora, por día, etc.). " +
                "Usar cuando el usuario necesita: consumo medio, evolución horaria/diaria, " +
                "valores máximos/mínimos en un periodo, tendencias, comparativas entre periodos, " +
                "resúmenes de consumo, informes energéticos. " +
                "Más eficiente que query-data para análisis y resúmenes.",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().optional().describe(
                    "ID del dispositivo a filtrar. Sin este parámetro, agrega datos de todos los dispositivos."
                ),
                magnitude: z.string().optional().describe(
                    "Magnitud a filtrar (ej: 'temperature', 'humidity', 'co2', 'generalelectricity'). " +
                    "Usar discover-collection para ver las disponibles."
                ),
                tags: z.array(z.object({
                    field: z.string().describe("Campo del tag por el que filtrar."),
                    values: z.array(z.string()).describe("Valores del tag. Múltiples valores se evalúan con OR.")
                })).optional().describe("Filtros adicionales por tags. Múltiples objetos tag se combinan con AND."),
                start: z.string().optional().describe("Fecha de inicio en ISO 8601. Usar junto con 'end'."),
                end: z.string().optional().describe("Fecha de fin en ISO 8601. Usar junto con 'start'."),
                last: z.number().optional().describe(
                    "Minutos hacia atrás desde ahora. Ej: 60 = última hora, 1440 = último día. Por defecto 60."
                ),
                timezone: z.string().optional().describe("Zona horaria. Por defecto 'Europe/Madrid'."),
                operations: z.enum(["avg", "min", "max", "sum", "count", "last"]).optional().describe(
                    "Función estadística: 'avg' (media), 'min', 'max', 'sum', 'count', 'last'. Por defecto 'avg'."
                ),
                interval_minutes: z.number().optional().describe(
                    "Intervalo de agrupación en minutos. Ej: 60 = horario, 1440 = diario. Por defecto 60."
                ),
                group_by: z.enum(["device_id", "magnitude"]).optional().describe(
                    "Agrupar por 'device_id' o 'magnitude'. Por defecto 'device_id'."
                ),
                export_format: z.enum(["json", "csv", "xml"]).optional().describe("Formato de exportación. Por defecto 'json'.")
            })
        },
        handler: async (params = {}) => {
            const result = await OpenApiMeasurements.fetchOpenApiQueryAggregation(params);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
    },
];

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


// ─────────────────────────────────────────────────────────────────────────────
//  Registro de tools en el servidor MCP
//  relevantToolNames = null  → registra las 4 tools (desarrollo / fallback)
//  relevantToolNames = [...] → registra solo las indicadas (producción)
// ─────────────────────────────────────────────────────────────────────────────
let toolsLogged = false; // Flag para evitar logging repetitivo de herramientas registradas

export function registerTools(server, relevantToolNames = null) {
    const toolsToRegister = relevantToolNames
        ? ALL_TOOLS.filter(t => relevantToolNames.includes(t.name))
        : ALL_TOOLS;

    //Hacemos el debug solamente una vez para que no aparezca todo el rato el mensaje.
    if (!toolsLogged) {
        logger.debug(
            { tools: toolsToRegister.map(t => t.name), filtered: relevantToolNames !== null },
            "Tools registradas en el servidor MCP"
        );
        toolsLogged = true;
    }

    for (const tool of toolsToRegister) {
        server.registerTool(tool.name, tool.definition, withLogging(tool.name, tool.handler));
    }
}