import { z } from "zod";
import { OpenApiMeasurements } from "../services/measurements.service.js";
import logger from "../config/logger.js";



// Schema reutilizable: colecciones IoT
const collectionEnum = z.enum([
    //"bim",
    "water",
    "energy",
    "weather",
    //"sensotran",
    "roomsensors",
    //"light",
    //"fv",
    //"irrigation",
    //"bibliotecaindoorambiental",
    "wifi",
    //"gva_weather",
]).describe(
    `Coleccion de datos IoT a consultar. Selecciona segun el tipo de consulta del usuario:\n` +

    `- 'bim': Sensores IoT de suelo Dragino LSE01 en jardines del campus y caudalimetro CZUS/50. ` +
        `Miden humedad del suelo, temperatura del suelo y conductividad electrica (tecnologia FDR con compensacion por temperatura y calibracion de fabrica para suelos minerales). ` +
        `Usar cuando pregunten por: estado del suelo, humedad de tierra, jardines inteligentes, conductividad del terreno, sensores de suelo, caudalimetro.\n` +

    `- 'water': Consumo de agua potable en edificios del campus. ` +
        `Usar cuando pregunten por: litros, m3, consumo de agua, gasto hidrico, fugas de agua, contadores de agua, agua potable.\n` +

    `- 'energy': Consumo electrico de edificios y zonas comunes del campus de la Universidad de Alicante (kWh). ` +
        `Usar cuando pregunten por: electricidad, consumo electrico, kilovatios, potencia electrica, factura de luz, contadores electricos.\n` +

    `- 'weather': Estacion meteorologica propia instalada en el campus de la Universidad de Alicante. ` +
        `Usar cuando pregunten por: temperatura exterior del campus, viento en la universidad, lluvia en el campus, humedad ambiente, presion atmosferica, clima del campus.\n` +

    //`- 'sensotran': Sensores de prevencion y seguridad de gases. ` +
    //    `Miden concentraciones de monoxido de carbono (CO), hidrogeno (H2), compuestos organicos volatiles (VOC) y gases inflamables. ` +
    //    `Objetivo: evaluar seguridad, detectar fugas y validar el sistema antes de despliegue definitivo. ` +
    //    `Usar cuando pregunten por: deteccion de gases, fugas de gas, seguridad de gases, CO, hidrogeno, VOC exterior, gases inflamables.\n` +

    `- 'roomsensors': Calidad ambiental interior de salas, aulas y despachos. ` +
        `Miden CO2, temperatura interior, humedad interior y VOC. ` +
        `Usar cuando pregunten por: CO2 en aulas, temperatura de una sala, humedad dentro de un edificio, calidad del aire interior, confort termico, ventilacion de salas.\n` +

    //`- 'light': Luminarias de exterior instaladas en el campus universitario. ` +
    //    `Usar cuando pregunten por: farolas, alumbrado exterior, iluminacion del campus, luminarias, luces exteriores.\n` +

    //`- 'fv': Produccion solar fotovoltaica de la Universidad de Alicante. ` +
    //    `Usar cuando pregunten por: paneles solares, produccion solar, energia renovable, autoconsumo, fotovoltaica, generacion solar.\n` +

    //`- 'irrigation': Gestion de agua de riego de jardines y zonas verdes del campus. ` +
    //    `Usar cuando pregunten por: riego, aspersores, agua de riego, zonas verdes, jardines, programacion de riego.\n` +

    //`- 'bibliotecaindoorambiental': Sensores ambientales interiores especificos de la Biblioteca General. ` +
    //    `Usar cuando pregunten por: ambiente en la biblioteca, temperatura de la biblioteca, CO2 en la biblioteca, humedad en la biblioteca. ` +
    //    `NOTA: si preguntan por calidad ambiental de OTROS edificios, usar 'roomsensors' en su lugar.\n` +

    `- 'wifi': Datos de conectividad WiFi del campus. ` +
        `Usar cuando pregunten por: conexiones WiFi, usuarios conectados, cobertura WiFi, red inalambrica, puntos de acceso, trafico de red.\n` 

    //`- 'gva_weather': Datos meteorologicos de la API de la Generalitat Valenciana (red de estaciones AVAMET/AEMET). ` +
    //    `Usar cuando pregunten por: meteorologia regional, clima de la Comunidad Valenciana, estaciones meteorologicas de la GVA, comparar clima campus vs region. ` +
    //    `NOTA: si pregunten por meteorologia especifica del campus, usar 'weather' en su lugar.`
);

// ─────────────────────────────────────────────────────────────────────────────
//  Definicion completa de las 4 tools
//  Cada entrada: { name, definition, handler }
// ─────────────────────────────────────────────────────────────────────────────
const ALL_TOOLS = [

    // ─── 1. DISCOVER-COLLECTION ──────────────────────────────────────────────
    {
        name: "discover-collection",
        definition: {
            description:
                "Devuelve toda la informacion de una coleccion IoT en una sola llamada: " +
                "descripcion general, lista de dispositivos (con IDs y alias) y magnitudes disponibles. " +
                "Usar como PRIMER PASO para cualquier consulta: " +
                "'que datos hay?', 'que sensores existen?', 'que mide esta coleccion?', " +
                "'que dispositivos hay en energia?', 'que magnitudes tiene el sensor X?'. " +
                "Tambien util para obtener IDs de dispositivos antes de consultar datos con query-data o query-aggregation.",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().optional().describe(
                    "ID de un dispositivo concreto para filtrar sus magnitudes. " +
                    "Si se omite, devuelve las magnitudes de toda la coleccion."
                )
            })
        },
        handler: async ({ collection, device_id }) => {
            if (device_id) {
                const [info, magnitudes] = await Promise.all([
                    OpenApiMeasurements.fetchOpenApiInfo(collection),
                    OpenApiMeasurements.fetchOpenApiMagnitudes(collection, device_id)
                ]);
                return {
                    content: [{ type: "text", text: JSON.stringify({ collection_info: info, magnitudes }, null, 2) }]
                };
            }

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
                "Devuelve los detalles completos de un dispositivo especifico: " +
                "nombre, alias, geolocalizacion (lat/lon), ubicacion dentro del edificio, " +
                "organizacion, tipo de metrica, codigo SIGUA del edificio y campos personalizados. " +
                "Usar cuando el usuario pregunta: 'donde esta este sensor?', 'que es el dispositivo X?', " +
                "'informacion del contador', 'ubicacion del equipo', 'detalles del sensor'. " +
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
                "exportar lecturas, ver cada medicion individual, detectar valores puntuales. " +
                "Para obtener estadisticas (media, maximo, minimo) o evolucion por horas/dias, " +
                "usar query-aggregation en su lugar, que es mas eficiente. " +
                "El rango temporal se define con start/end (fechas absolutas) o last (minutos hacia atras).",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().optional().describe(
                    "ID del dispositivo a filtrar. Sin este parametro, devuelve datos de todos los dispositivos."
                ),
                magnitude: z.string().optional().describe(
                    "Magnitud a filtrar (ej: 'temperature', 'humidity', 'co2', 'generalelectricity'). " +
                    "Usar discover-collection para ver las magnitudes disponibles."
                ),
                tags: z.array(z.object({
                    field: z.string().describe("Campo del tag por el que filtrar."),
                    values: z.array(z.string()).describe("Valores del tag. Multiples valores se evaluan con OR.")
                })).optional().describe("Filtros adicionales por tags. Multiples objetos tag se combinan con AND."),
                start: z.string().optional().describe("Fecha de inicio en ISO 8601. Usar junto con 'end'."),
                end: z.string().optional().describe("Fecha de fin en ISO 8601. Usar junto con 'start'."),
                last: z.number().optional().describe(
                    "Minutos hacia atras desde ahora. Ej: 60 = ultima hora, 1440 = ultimo dia. Por defecto 60."
                ),
                timezone: z.string().optional().describe("Zona horaria. Por defecto 'Europe/Madrid'."),
                limit: z.number().optional().describe("Numero maximo de resultados. Por defecto 1000."),
                include_metadata: z.boolean().optional().describe("Si true, incluye metadatos del dispositivo. Por defecto false."),
                export_format: z.enum(["json", "csv", "xml"]).optional().describe("Formato de exportacion. Por defecto 'json'.")
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
                "Aplica funciones estadisticas (media, minimo, maximo, suma, cuenta, ultimo valor) " +
                "sobre los datos agrupados en intervalos configurables (por hora, por dia, etc.). " +
                "Usar cuando el usuario necesita: consumo medio, evolucion horaria/diaria, " +
                "valores maximos/minimos en un periodo, tendencias, comparativas entre periodos, " +
                "resumenes de consumo, informes energeticos. " +
                "Mas eficiente que query-data para analisis y resumenes.",
            inputSchema: z.object({
                collection: collectionEnum,
                device_id: z.string().optional().describe(
                    "ID del dispositivo a filtrar. Sin este parametro, agrega datos de todos los dispositivos."
                ),
                magnitude: z.string().optional().describe(
                    "Magnitud a filtrar (ej: 'temperature', 'humidity', 'co2', 'generalelectricity'). " +
                    "Usar discover-collection para ver las disponibles."
                ),
                tags: z.array(z.object({
                    field: z.string().describe("Campo del tag por el que filtrar."),
                    values: z.array(z.string()).describe("Valores del tag. Multiples valores se evaluan con OR.")
                })).optional().describe("Filtros adicionales por tags. Multiples objetos tag se combinan con AND."),
                start: z.string().optional().describe("Fecha de inicio en ISO 8601. Usar junto con 'end'."),
                end: z.string().optional().describe("Fecha de fin en ISO 8601. Usar junto con 'start'."),
                last: z.number().optional().describe(
                    "Minutos hacia atras desde ahora. Ej: 60 = ultima hora, 1440 = ultimo dia. Por defecto 60."
                ),
                timezone: z.string().optional().describe("Zona horaria. Por defecto 'Europe/Madrid'."),
                operations: z.enum(["avg", "min", "max", "sum", "count", "last"]).optional().describe(
                    "Funcion estadistica: 'avg' (media), 'min', 'max', 'sum', 'count', 'last'. Por defecto 'avg'."
                ),
                interval_minutes: z.number().optional().describe(
                    "Intervalo de agrupacion en minutos. Ej: 60 = horario, 1440 = diario. Por defecto 60."
                ),
                group_by: z.enum(["device_id", "magnitude"]).optional().describe(
                    "Agrupar por 'device_id' o 'magnitude'. Por defecto 'device_id'."
                ),
                export_format: z.enum(["json", "csv", "xml"]).optional().describe("Formato de exportacion. Por defecto 'json'.")
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

// Wrapper de logging por tool — consistente con el formato [4/5] del index.js
function withLogging(name, handler) {
    return async (params) => {
        const start = Date.now();
        logger.debug({ tool: name, params }, "[4/5] CALL  -> Parametros de la herramienta");
        try {
            const result = await handler(params);
            logger.info({ tool: name, ms: Date.now() - start }, "[4/5] RESULT-> Tool completada en API Kunna");
            return result;
        } catch (err) {
            logger.error({ tool: name, err }, "[4/5] ERROR -> Tool fallida en API Kunna");
            throw err;
        }
    };
}


// ─────────────────────────────────────────────────────────────────────────────
//  Registro de tools en el servidor MCP
//  relevantToolNames = null  -> registra todas las tools
//  relevantToolNames = [...] -> registra solo las indicadas
// ─────────────────────────────────────────────────────────────────────────────
export function registerTools(server, relevantToolNames = null) {
    const toolsToRegister = relevantToolNames
        ? ALL_TOOLS.filter(t => relevantToolNames.includes(t.name))
        : ALL_TOOLS;

    for (const tool of toolsToRegister) {
        server.registerTool(tool.name, tool.definition, withLogging(tool.name, tool.handler));
    }
}