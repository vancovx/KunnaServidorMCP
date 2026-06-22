import { z } from "zod";


export function registerPrompts(server) {

    // ─────────────────────────────────────────────────────────────────────────
    //  1. Informe mensual de ELECTRICIDAD de un edificio + detección de anomalías
    // ─────────────────────────────────────────────────────────────────────────
    server.registerPrompt(
        "informe-electricidad-edificio-mensual",
        {
            description: "Genera un informe exhaustivo del consumo eléctrico de un edificio durante un mes concreto, detecta anomalías y presenta los resultados de forma estructurada. Se puede identificar el edificio por código SIGUA, nombre oficial o descripción libre ('la poli', 'derecho', 'donde se imparte enfermería').",
            inputSchema: z.object({
                edificio: z.string().describe("Identificador del edificio. Puede ser el código SIGUA (ej: '0025', '0038'), el nombre oficial ('Escuela Politécnica Superior I'), un nombre coloquial ('la poli', 'EPS', 'derecho') o una descripción libre ('donde se imparte informática'). El sistema usa búsqueda semántica para resolverlo."),
                mes: z.string().describe("Mes a analizar en formato YYYY-MM (ej: '2025-06' para junio de 2025)."),
            })
        },
        async (args) => {
            console.error("Args recibidos (informe-electricidad):", JSON.stringify(args));

            const edificio = args?.edificio ?? args?.arguments?.edificio ?? "sin_identificador";
            const mes      = args?.mes      ?? args?.arguments?.mes      ?? "2025-01";

            const [year, month] = mes.split("-");
            const start = `${year}-${month}-01T00:00:00.000Z`;
            const lastDay = new Date(Number(year), Number(month), 0).getDate();
            const end = `${year}-${month}-${String(lastDay).padStart(2, "0")}T23:59:59.000Z`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Eres un experto en análisis energético de edificios universitarios. Genera un informe exhaustivo del consumo eléctrico del edificio identificado como "${edificio}" durante el mes ${mes} (del ${start} al ${end}).

                                Sigue estos pasos en orden estricto:

                                ─── PASO 1: Identificar el edificio ───
                                Usa "search-campus-buildings" con query="${edificio}" para resolver el identificador del usuario.
                                - Si la búsqueda devuelve un único resultado con alta confianza (>80%), úsalo.
                                - Si devuelve varios resultados, indica al usuario las opciones encontradas y elige la más probable; menciona explícitamente qué edificio has elegido y por qué.
                                - Si no devuelve resultados, muestra al usuario las opciones disponibles y detente.
                                Guarda el código SIGUA del edificio resuelto para los siguientes pasos.

                                ─── PASO 2: Identificar los contadores eléctricos del edificio y obtener sus metadatos (en UNA SOLA llamada) ───
                                Haz UNA ÚNICA llamada a "query-data" con:
                                - collection = "energy"
                                - limit = 800
                                - include_metadata = true
                                Esta llamada devuelve, en una sola petición, TODOS los dispositivos de la colección junto con sus metadatos completos (alias, ubicación dentro del edificio, geolocalización, código SIGUA, organización, tipo de métrica, campos personalizados).

                                A partir de esa respuesta, filtra in-memory los dispositivos que pertenezcan al edificio identificado en el paso 1 (busca coincidencias por código SIGUA en los metadatos, y en su defecto por nombre o alias del dispositivo).

                                IMPORTANTE: No llames a "discover-collection" ni a "get-device-details" en este paso, sería ineficiente. Toda la información necesaria viene en la respuesta de "query-data" con include_metadata=true.

                                Si no encuentras contadores asociados al edificio, indícalo y detente.

                                ─── PASO 3: Datos agregados diarios ───
                                Para cada dispositivo, usa "query-aggregation" con:
                                - collection = "energy"
                                - device_id = (el ID del dispositivo)
                                - start = "${start}"
                                - end = "${end}"
                                - operations = "avg"
                                - interval_minutes = 1440 (agrupación diaria)
                                Repite con operations = "max" y operations = "min".

                                ─── PASO 4: Datos agregados horarios (para detectar anomalías) ───
                                Usa "query-aggregation" con:
                                - interval_minutes = 60 (agrupación horaria)
                                - operations = "avg"
                                - Mismo rango de fechas y dispositivos.

                                ─── PASO 5: Generar el informe con esta estructura ───

                                ## 1. Datos del edificio
                                - Código SIGUA, nombre del edificio, número de contadores encontrados.
                                - Lista de contadores con su alias y ubicación.

                                ## 2. Resumen de consumo mensual (kWh)
                                - Consumo total estimado del edificio (suma de todos los contadores).
                                - Consumo medio diario.
                                - Día de mayor consumo y día de menor consumo.
                                - Tabla resumen por contador: alias, consumo medio diario, máximo, mínimo.

                                ## 3. Evolución diaria
                                - Describe la tendencia del consumo a lo largo del mes.
                                - Identifica patrones claros (ej: bajada en fines de semana, picos al inicio de semana).

                                ## 4. Análisis horario y patrones
                                - Describe el patrón horario típico del edificio.
                                - Compara días laborables vs fines de semana si los datos lo permiten.

                                ## 5. Detección de anomalías
                                Aplica estos criterios:
                                a) **Picos extremos**: cualquier valor horario que supere en más de 2 desviaciones estándar la media horaria del mes.
                                b) **Consumo nocturno inusual**: consumo entre las 00:00-06:00 que supere el 30% del consumo medio diurno.
                                c) **Días atípicos**: días cuyo consumo total se desvíe más de 1.5 desviaciones estándar de la media diaria.
                                d) **Caídas a cero**: periodos donde el consumo cae a 0 durante horas laborables.

                                Para cada anomalía indica: fecha/hora, contador afectado, valor registrado, valor esperado y tipo de anomalía.
                                Si no se detectan anomalías, indícalo explícitamente.

                                ## 6. Conclusiones y recomendaciones
                                - Resumen ejecutivo del estado del consumo eléctrico del edificio.
                                - Si hay anomalías, sugiere posibles causas y acciones.
                                - Valora si el patrón es coherente con el uso esperado de un edificio universitario.

                                Importante: Presenta los datos de forma clara, usa tablas cuando sea apropiado. Si algún paso falla o no devuelve datos, indícalo y continúa con los datos disponibles.`
                        }
                    }
                ]
            };
        }
    );


    // ─────────────────────────────────────────────────────────────────────────
    //  2. Informe mensual de AGUA de un edificio + detección de anomalías
    // ─────────────────────────────────────────────────────────────────────────
    server.registerPrompt(
        "informe-agua-edificio-mensual",
        {
            description: "Genera un informe exhaustivo del consumo de agua potable de un edificio durante un mes concreto, detecta posibles fugas y consumos anómalos. Se puede identificar el edificio por código SIGUA, nombre oficial o descripción libre.",
            inputSchema: z.object({
                edificio: z.string().describe("Identificador del edificio. Puede ser el código SIGUA (ej: '0025'), el nombre oficial, un nombre coloquial ('la poli', 'derecho') o una descripción libre ('donde se imparte enfermería'). El sistema usa búsqueda semántica para resolverlo."),
                mes: z.string().describe("Mes a analizar en formato YYYY-MM (ej: '2025-06')."),
            })
        },
        async (args) => {
            console.error("Args recibidos (informe-agua):", JSON.stringify(args));

            const edificio = args?.edificio ?? args?.arguments?.edificio ?? "sin_identificador";
            const mes      = args?.mes      ?? args?.arguments?.mes      ?? "2025-01";

            const [year, month] = mes.split("-");
            const start = `${year}-${month}-01T00:00:00.000Z`;
            const lastDay = new Date(Number(year), Number(month), 0).getDate();
            const end = `${year}-${month}-${String(lastDay).padStart(2, "0")}T23:59:59.000Z`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Eres un experto en gestión hídrica de edificios universitarios. Genera un informe exhaustivo del consumo de agua potable del edificio identificado como "${edificio}" durante el mes ${mes} (del ${start} al ${end}).

                                Sigue estos pasos en orden estricto:

                                ─── PASO 1: Identificar el edificio ───
                                Usa "search-campus-buildings" con query="${edificio}" para resolver el identificador.
                                - Si la búsqueda devuelve un único resultado con alta confianza, úsalo.
                                - Si devuelve varios, indica las opciones, elige la más probable y justifica la elección.
                                - Si no hay resultados, muestra los edificios disponibles y detente.
                                Guarda el código SIGUA del edificio resuelto.

                                ─── PASO 2: Identificar los contadores de agua del edificio y obtener sus metadatos (en UNA SOLA llamada) ───
                                Haz UNA ÚNICA llamada a "query-data" con:
                                - collection = "water"
                                - start = "${start}"
                                - end = "${end}"
                                - limit = 1
                                - include_metadata = true
                                Esta llamada devuelve, en una sola petición, TODOS los dispositivos de la colección junto con sus metadatos completos (alias, ubicación dentro del edificio, geolocalización, código SIGUA, organización, tipo de métrica, campos personalizados).

                                A partir de esa respuesta, filtra in-memory los dispositivos que pertenezcan al edificio identificado en el paso 1 (busca coincidencias por código SIGUA en los metadatos, y en su defecto por nombre o alias del dispositivo).

                                IMPORTANTE: No llames a "discover-collection" ni a "get-device-details" en este paso, sería ineficiente. Toda la información necesaria viene en la respuesta de "query-data" con include_metadata=true.

                                Si no encuentras contadores asociados al edificio, indícalo y detente.

                                ─── PASO 3: Datos agregados diarios ───
                                Para cada dispositivo, usa "query-aggregation" con:
                                - collection = "water"
                                - device_id = (el ID del dispositivo)
                                - start = "${start}"
                                - end = "${end}"
                                - operations = "avg"
                                - interval_minutes = 1440 (agrupación diaria)
                                Repite con operations = "max", "min" y "sum" para tener el total diario.

                                ─── PASO 4: Datos agregados horarios (para detectar fugas) ───
                                Usa "query-aggregation" con:
                                - interval_minutes = 60 (agrupación horaria)
                                - operations = "avg"
                                - Mismo rango de fechas y dispositivos.

                                ─── PASO 5: Generar el informe con esta estructura ───

                                ## 1. Datos del edificio
                                - Código SIGUA, nombre del edificio, número de contadores de agua encontrados.
                                - Lista de contadores con su alias y ubicación.

                                ## 2. Resumen de consumo mensual (litros / m³)
                                - Consumo total estimado del edificio.
                                - Consumo medio diario.
                                - Día de mayor consumo y día de menor consumo.
                                - Tabla resumen por contador: alias, consumo total mensual, medio diario, máximo, mínimo.

                                ## 3. Evolución diaria
                                - Describe la tendencia del consumo a lo largo del mes.
                                - Identifica patrones (ej: bajada drástica en fines de semana o periodos vacacionales).

                                ## 4. Análisis horario
                                - Describe el patrón horario típico (mayor consumo en horarios de cambio de clase, hora del café, etc.).
                                - Compara días laborables vs fines de semana.

                                ## 5. Detección de anomalías y posibles fugas
                                Aplica estos criterios:
                                a) **Consumo nocturno sospechoso (posible fuga)**: consumo constante entre las 23:00-06:00 superior al 10% del consumo medio diurno. Una fuga típica se manifiesta como un caudal pequeño pero CONTINUO durante horas en las que el edificio está vacío.
                                b) **Caudal base elevado**: si el mínimo horario nunca baja por debajo de un cierto valor durante el mes, sospecha de fuga estructural.
                                c) **Picos extremos**: cualquier valor horario que supere en más de 2 desviaciones estándar la media.
                                d) **Días atípicos**: días cuyo consumo total se desvíe más de 1.5 desviaciones estándar de la media diaria.
                                e) **Caídas a cero**: periodos donde el consumo cae a 0 durante horas con actividad esperada (puede indicar contador averiado o corte).

                                Para cada anomalía indica: fecha/hora, contador afectado, valor registrado, valor esperado y tipo de anomalía.
                                Si no se detectan anomalías, indícalo explícitamente.

                                ## 6. Conclusiones y recomendaciones
                                - Resumen ejecutivo del estado del consumo hídrico.
                                - Si hay sospecha de fuga, marca su nivel de prioridad y sugiere la revisión.
                                - Valora si el patrón es coherente con el uso esperado del edificio.

                                Importante: Presenta los datos de forma clara, usa tablas cuando sea apropiado. Si algún paso falla, indícalo y continúa con los datos disponibles.`
                        }
                    }
                ]
            };
        }
    );


    // ─────────────────────────────────────────────────────────────────────────
    //  3. Informe de CONFORT AMBIENTAL en un aula (roomsensors)
    // ─────────────────────────────────────────────────────────────────────────
    server.registerPrompt(
        "informe-confort-aula",
        {
            description: "Analiza la calidad ambiental interior de un aula, despacho o sala (CO2, temperatura, humedad y VOC) en un periodo concreto. Evalúa el confort según normativa, detecta problemas de ventilación o climatización y sugiere mejoras. Usa sensores de la colección 'roomsensors'.",
            inputSchema: z.object({
                aula: z.string().describe("Identificador del aula o sala. Puede ser un código (ej: 'A1/0M01'), un nombre ('aula magna', 'aula 12 politecnica'), una descripción ('despachos de informática') o un edificio entero. El sistema usará búsqueda semántica sobre edificios y filtrado de dispositivos para localizarla."),
                desde: z.string().describe("Fecha inicial del análisis en formato YYYY-MM-DD."),
                hasta: z.string().describe("Fecha final del análisis en formato YYYY-MM-DD.")
            })
        },
        async (args) => {
            console.error("Args recibidos (informe-confort-aula):", JSON.stringify(args));

            const aula  = args?.aula  ?? args?.arguments?.aula  ?? "sin_identificador";
            const desde = args?.desde ?? args?.arguments?.desde ?? "2025-01-01";
            const hasta = args?.hasta ?? args?.arguments?.hasta ?? "2025-01-07";

            const start = `${desde}T00:00:00.000Z`;
            const end   = `${hasta}T23:59:59.000Z`;

            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Eres un experto en calidad ambiental interior y confort en edificios universitarios. Analiza la calidad del aire y el confort térmico de "${aula}" entre el ${desde} y el ${hasta} (UTC: del ${start} al ${end}).

                                Sigue estos pasos en orden estricto:

                                ─── PASO 1: Identificar el edificio asociado ───
                                Si el usuario menciona un edificio o zona, usa "search-campus-buildings" con query="${aula}" para identificar el edificio asociado y obtener su código SIGUA.
                                Si la query es claramente un código de sensor específico (ej: 'A1/0M01') sin referencia a edificio, puedes saltarte este paso.

                                ─── PASO 2: Localizar los sensores ambientales y obtener sus metadatos (en UNA SOLA llamada) ───
                                Haz UNA ÚNICA llamada a "query-data" con:
                                - collection = "roomsensors"
                                - start = "${start}"
                                - end = "${end}"
                                - limit = 1
                                - include_metadata = true
                                Esta llamada devuelve, en una sola petición, TODOS los sensores ambientales junto con sus metadatos completos (alias, ubicación exacta dentro del edificio, planta, geolocalización, código SIGUA, organización, campos personalizados) Y las magnitudes que están midiendo en ese rango temporal.

                                A partir de esa respuesta, filtra in-memory los sensores que coincidan con la consulta del usuario:
                                - Si la query es un código específico (ej: 'A1/0M01'), búscalo exactamente en el alias o el id del dispositivo.
                                - Si es un nombre/descripción, filtra por el código SIGUA del edificio identificado en el paso 1 y por palabras clave en el alias o ubicación.

                                IMPORTANTE: No llames a "discover-collection" ni a "get-device-details" en este paso, sería ineficiente. Toda la información necesaria (dispositivos, ubicaciones, magnitudes presentes) viene en la respuesta de "query-data" con include_metadata=true.

                                Si hay varios sensores candidatos, indica al usuario cuáles has encontrado y elige los más probables justificando la elección. Si no encuentras ningún sensor, indícalo y detente; las magnitudes esperadas para esta colección son: CO2, temperatura interior, humedad interior y VOC.

                                ─── PASO 3: Obtener datos agregados horarios de cada magnitud ───
                                Para cada sensor identificado y cada magnitud (co2, temperature, humidity, voc), usa "query-aggregation" con:
                                - collection = "roomsensors"
                                - device_id = (id del sensor)
                                - magnitude = (la magnitud)
                                - start = "${start}"
                                - end = "${end}"
                                - operations = "avg"
                                - interval_minutes = 60

                                ─── PASO 4: Obtener máximos y mínimos diarios de CO2 y temperatura ───
                                Repite "query-aggregation" para CO2 y temperatura con:
                                - operations = "max" y luego "min"
                                - interval_minutes = 1440 (diario)
                                Esto permite identificar los peores momentos del día.

                                ─── PASO 5: Generar el informe con esta estructura ───

                                ## 1. Aula/sala analizada
                                - Edificio (código SIGUA y nombre).
                                - Ubicación exacta dentro del edificio (planta, sala).
                                - Sensores utilizados con su alias.
                                - Periodo analizado y número total de horas con datos.

                                ## 2. Resumen ambiental del periodo
                                Tabla con: magnitud · media · máximo · mínimo · unidad
                                - CO2 (ppm)
                                - Temperatura interior (°C)
                                - Humedad relativa (%)
                                - VOC (índice)

                                ## 3. Evaluación de confort según normativa
                                Aplica estos umbrales (basados en RITE y recomendaciones de calidad de aire interior):

                                **CO2 (ventilación)**
                                - < 800 ppm: excelente
                                - 800 - 1000 ppm: aceptable
                                - 1000 - 1400 ppm: ventilación insuficiente
                                - > 1400 ppm: deficiente, puede causar somnolencia y bajo rendimiento

                                **Temperatura (confort térmico)**
                                - Invierno: 21 - 23 °C óptimo, 20 - 24 °C aceptable
                                - Verano: 23 - 25 °C óptimo, 22 - 26 °C aceptable
                                - Fuera de rango: incómodo

                                **Humedad relativa**
                                - 40 - 60 %: óptimo
                                - 30 - 40 % o 60 - 70 %: aceptable
                                - < 30 % o > 70 %: incómodo, puede afectar a la salud

                                **VOC**
                                - Bajo: calidad de aire buena
                                - Medio: aceptable, ventilar si es continuo
                                - Alto: ventilar inmediatamente

                                Indica el porcentaje del tiempo que cada magnitud estuvo en cada rango.

                                ## 4. Patrones horarios y diarios
                                - Describe cómo evolucionan las magnitudes a lo largo del día (ej: subida de CO2 durante clases, picos a media mañana).
                                - Diferencia días laborables vs fines de semana.
                                - Identifica las franjas horarias más críticas.

                                ## 5. Eventos relevantes
                                a) **Picos de CO2**: momentos en que se supera 1400 ppm. Indica día, hora y duración.
                                b) **Disconfort térmico prolongado**: periodos de más de 2 horas con temperatura fuera del rango aceptable.
                                c) **Humedad extrema**: periodos por debajo del 30 % o por encima del 70 %.
                                d) **Posibles fallos de sensor**: valores planos (constantes) durante horas o valores físicamente imposibles.

                                ## 6. Diagnóstico y recomendaciones
                                - Valoración global del confort del aula (buena, aceptable, deficiente).
                                - Si el CO2 sube en exceso durante las clases: posible problema de ventilación o aforo excesivo.
                                - Si la temperatura está fuera de rango: revisar climatización y consigna.
                                - Si la humedad es extrema: valorar humidificación/deshumidificación o estanqueidad.
                                - Recomendaciones concretas y priorizadas.

                                Importante: Presenta los datos con tablas y porcentajes claros. Si algún paso falla o falta alguna magnitud, indícalo explícitamente y continúa con las disponibles.`
                        }
                    }
                ]
            };
        }
    );

}