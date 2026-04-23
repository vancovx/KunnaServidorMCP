import { readdir, readFile } from "fs/promises";
import { join } from "path";
import logger from "../config/logger.js";

// Sinónimos conocidos de edificios
// Clave: código SIGUA → array de nombres alternativos (en minúsculas).
const BUILDING_SYNONYMS = {
    "0001": ["zona deportiva", "deportes", "pabellón deportivo", "polideportivo", "gimnasio"],
    "0002": ["experimentación industrial", "nave industrial", "talleres industriales"],
    "0003": ["ciencias 3", "ciencias tres", "ciencias iii", "facultad ciencias 3"],
    "0004": ["ciencias 4", "ciencias cuatro", "ciencias iv", "facultad ciencias 4"],
    "0005": ["informática", "servicio informática", "centro de cálculo", "si"],
    "0006": ["polivalente", "polivalente 1", "edificio polivalente"],
    "0007": ["ciencias 2", "ciencias dos", "ciencias ii", "facultad ciencias 2"],
    "0008": ["ciencias 1", "ciencias uno", "ciencias i", "facultad ciencias 1", "ciencias"],
    "0009": ["biotecnología", "biotec", "pabellón biotecnología"],
    "0010": ["ciencias 5", "ciencias cinco", "ciencias v", "facultad ciencias 5"],
    "0011": ["derecho", "facultad derecho", "la facultad de derecho"],
    "0012": ["pabellón 12", "pabellon 12", "edificio 12"],
    "0013": ["pabellón 13", "pabellon 13", "edificio 13"],
    "0014": ["politécnica 3", "politecnica 3", "eps 3", "eps iii", "escuela politécnica 3"],
    "0015": ["politécnica 2", "politecnica 2", "eps 2", "eps ii", "escuela politécnica 2", "la poli 2"],
    "0016": ["politécnica 1", "politecnica 1", "eps 1", "eps i", "escuela politécnica 1", "la poli", "la politécnica", "eps"],
    "0017": ["club social", "club social 1", "cafetería club social"],
    "0018": ["letras 3", "letras tres", "letras iii", "filosofía 3", "filosofia 3"],
    "0019": ["letras 2", "letras dos", "letras ii", "geografía", "historia", "filosofía 2", "filosofia 2"],
    "0020": ["letras 1", "letras uno", "letras i", "filología", "filologia", "filosofía 1", "filosofia 1"],
};


class _CampusService {
    constructor() {
        /** @type {Map<string, BuildingData>} código SIGUA → datos del edificio */
        this.buildings = new Map();

        /** @type {Array<{ id: string, searchText: string }>} índice de búsqueda textual */
        this.searchIndex = [];

        this.isReady = false;
    }

    /**
     * Carga todos los GeoJSON de edificios desde la carpeta data/buildings.
     * Llamar UNA VEZ al arrancar el servidor.
     *
     * @param {string} buildingsDir - Ruta a la carpeta con los GeoJSON.
     *   Por defecto: src/data/buildings/ relativo al cwd.
     */
    async initialize(buildingsDir) {
        const dir = buildingsDir ?? join(process.cwd(), "src", "data", "buildings");
        const start = Date.now();

        logger.info({ dir }, "CampusService inicializando");

        // Leer todos los .json de la carpeta
        const files = (await readdir(dir)).filter(f => f.endsWith(".json")).sort();

        logger.debug({ total: files.length }, "Archivos GeoJSON encontrados");

        let loaded = 0;
        let skipped = 0;

        for (const file of files) {
            try {
                const raw = await readFile(join(dir, file), "utf-8");
                const geojson = JSON.parse(raw);
                const feature = geojson.features?.[0];

                if (!feature?.properties?.id) {
                    logger.warn({ file }, "GeoJSON sin id en properties — ignorado");
                    skipped++;
                    continue;
                }

                const props = feature.properties;
                const bbox = props.bbox.split(",").map(Number);
                const plantas = props.plantas.replace(/[{}]/g, "").split(",").filter(Boolean);

                const building = {
                    id: props.id,
                    nombre: props.nombre,
                    plantas,
                    num_plantas: plantas.length,
                    bbox: {
                        min_lon: bbox[0],
                        min_lat: bbox[1],
                        max_lon: bbox[2],
                        max_lat: bbox[3],
                    },
                    center: {
                        lon: (bbox[0] + bbox[2]) / 2,
                        lat: (bbox[1] + bbox[3]) / 2,
                    },
                    geometry: feature.geometry,
                    synonyms: BUILDING_SYNONYMS[props.id] ?? [],
                };

                this.buildings.set(props.id, building);
                loaded++;
            } catch (err) {
                logger.error({ file, err }, "Error cargando GeoJSON");
                skipped++;
            }
        }

        // Construir índice de búsqueda
        this._buildSearchIndex();

        this.isReady = true;
        logger.info(
            { loaded, skipped, ms: Date.now() - start },
            "CampusService listo"
        );
    }

    /**
     * Construye el índice de búsqueda textual.
     * Para cada edificio, genera un string normalizado con el nombre,
     * código, sinónimos y plantas — todo en minúsculas y sin tildes.
     */
    _buildSearchIndex() {
        this.searchIndex = [];

        for (const [id, b] of this.buildings) {
            const parts = [
                id,
                b.nombre,
                ...b.synonyms,
                ...b.plantas,
            ];

            this.searchIndex.push({
                id,
                searchText: this._normalize(parts.join(" ")),
            });
        }

        logger.debug({ total: this.searchIndex.length }, "Indice de busqueda construido");
    }

    // ─────────────────────────────────────────────────────────
    //  BÚSQUEDA
    // ─────────────────────────────────────────────────────────

    /**
     * Busca edificios por texto libre.
     * Soporta: código SIGUA, nombre parcial, sinónimos, búsqueda fuzzy.
     *
     * @param {string} query - Texto del usuario (ej: "la poli", "0014", "ciencias")
     * @param {number} limit - Máximo de resultados (default: 5)
     * @returns {Array<{ building, score, matchType }>}
     */
    searchBuildings(query, limit = 5) {
        this._ensureReady();

        const normalized = this._normalize(query);
        const start = Date.now();

        // 1. Intento exacto por código SIGUA
        //    "0014" o "14" → buscar con padding de ceros
        const codeMatch = this._matchByCode(normalized);
        if (codeMatch) {
            logger.debug(
                { query, matchType: "exact_code", id: codeMatch.id, ms: Date.now() - start },
                "Busqueda de edificio completada"
            );
            return [{
                building: this._toPublic(codeMatch),
                score: 1.0,
                matchType: "exact_code",
            }];
        }

        // 2. Búsqueda por texto con scoring
        const results = [];

        for (const entry of this.searchIndex) {
            const score = this._calculateScore(normalized, entry.searchText);
            if (score > 0) {
                results.push({
                    building: this._toPublic(this.buildings.get(entry.id)),
                    score,
                    matchType: score >= 0.8 ? "exact_name" : score >= 0.4 ? "partial" : "fuzzy",
                });
            }
        }

        const sorted = results.sort((a, b) => b.score - a.score).slice(0, limit);

        if (sorted.length === 0) {
            logger.warn({ query }, "Busqueda de edificio sin resultados");
        } else {
            logger.debug(
                {
                    query,
                    results: sorted.length,
                    best: { id: sorted[0].building.id, nombre: sorted[0].building.nombre, score: sorted[0].score, matchType: sorted[0].matchType },
                    ms: Date.now() - start
                },
                "Busqueda de edificio completada"
            );
        }

        return sorted;
    }

    /**
     * Obtiene un edificio por su código SIGUA exacto.
     *
     * @param {string} id - Código SIGUA (ej: "0014", "14")
     * @returns {object|null}
     */
    getBuildingById(id) {
        this._ensureReady();

        // Normalizar: "14" → "0014"
        const padded = id.replace(/\D/g, "").padStart(4, "0");
        const building = this.buildings.get(padded);

        if (!building) {
            logger.warn({ id, padded }, "Edificio no encontrado por ID");
        } else {
            logger.debug({ id: padded, nombre: building.nombre }, "Edificio encontrado por ID");
        }

        return building ? this._toPublic(building) : null;
    }

    /**
     * Devuelve TODOS los edificios (útil para listados).
     * @returns {Array<object>}
     */
    getAllBuildings() {
        this._ensureReady();

        logger.debug({ total: this.buildings.size }, "Devolviendo todos los edificios");

        return Array.from(this.buildings.values()).map(b => this._toPublic(b));
    }

    /**
     * Busca edificios cercanos a unas coordenadas.
     *
     * @param {number} lat
     * @param {number} lon
     * @param {number} limit - Máximo de resultados (default: 3)
     * @returns {Array<{ building, distance_m }>}
     */
    findNearby(lat, lon, limit = 3) {
        this._ensureReady();

        const results = Array.from(this.buildings.values()).map(b => ({
            building: this._toPublic(b),
            distance_m: this._haversineDistance(lat, lon, b.center.lat, b.center.lon),
        }));

        const sorted = results.sort((a, b) => a.distance_m - b.distance_m).slice(0, limit);

        logger.debug(
            {
                lat, lon,
                results: sorted.length,
                nearest: { id: sorted[0]?.building.id, nombre: sorted[0]?.building.nombre, distance_m: Math.round(sorted[0]?.distance_m) }
            },
            "Busqueda de edificios cercanos completada"
        );

        return sorted;
    }


    // ─────────────────────────────────────────────────────────
    //  SCORING Y MATCHING
    // ─────────────────────────────────────────────────────────

    /**
     * Intenta hacer match directo por código SIGUA.
     * Acepta: "0014", "14", "0014".
     */
    _matchByCode(normalizedQuery) {
        // Si la query es solo dígitos (posiblemente con espacios)
        const digits = normalizedQuery.replace(/\s/g, "");
        if (/^\d{1,4}$/.test(digits)) {
            const padded = digits.padStart(4, "0");
            return this.buildings.get(padded) ?? null;
        }

        // Si contiene "edificio 14" o "sigua 0014"
        const codePattern = /(?:edificio|sigua|codigo|código)\s*(\d{1,4})/;
        const match = normalizedQuery.match(codePattern);
        if (match) {
            const padded = match[1].padStart(4, "0");
            return this.buildings.get(padded) ?? null;
        }

        return null;
    }

    /**
     * Calcula un score de relevancia entre la query y el texto de búsqueda.
     * Combina: coincidencia exacta de palabras, subcadenas y orden.
     *
     * @returns {number} Score entre 0.0 y 1.0
     */
    _calculateScore(normalizedQuery, searchText) {
        // Coincidencia exacta de la query completa
        if (searchText.includes(normalizedQuery)) {
            // Más puntuación si el texto es corto (match más específico)
            return 0.8 + (0.2 * (normalizedQuery.length / searchText.length));
        }

        // Coincidencia por palabras individuales
        const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
        if (queryWords.length === 0) return 0;

        let matchedWords = 0;
        let matchedChars = 0;

        for (const word of queryWords) {
            if (searchText.includes(word)) {
                matchedWords++;
                matchedChars += word.length;
            }
        }

        if (matchedWords === 0) return 0;

        // Score = proporción de palabras que coinciden, ponderado por longitud
        const wordScore = matchedWords / queryWords.length;
        const charScore = matchedChars / normalizedQuery.replace(/\s/g, "").length;

        return (wordScore * 0.6 + charScore * 0.4);
    }


    // Funciones varias

    // Normaliza texto: minúsculas, sin tildes, sin caracteres especiales.
    _normalize(text) {
        return text
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")   // quitar tildes
            .replace(/[^a-z0-9\s]/g, " ")      // solo letras, números, espacios
            .replace(/\s+/g, " ")              // colapsar espacios
            .trim();
    }

    // Devuelve la versión pública de un edificio (sin geometry que es muy pesada).
    // La geometry se puede pedir aparte con getBuildingGeometry().
    _toPublic(building) {
        return {
            id: building.id,
            nombre: building.nombre,
            plantas: building.plantas,
            num_plantas: building.num_plantas,
            bbox: building.bbox,
            center: building.center,
            synonyms: building.synonyms,
        };
    }

    // Devuelve la geometry GeoJSON de un edificio (para mapas).
    // Separada de toPublic porque puede ser muy grande.
    getBuildingGeometry(id) {
        this._ensureReady();
        const padded = id.replace(/\D/g, "").padStart(4, "0");
        const building = this.buildings.get(padded);

        if (!building) {
            logger.warn({ id, padded }, "Geometria no encontrada para el edificio");
        }

        return building?.geometry ?? null;
    }

    // Distancia en metros entre dos puntos (fórmula de Haversine).
    _haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    _ensureReady() {
        if (!this.isReady) {
            logger.error("CampusService usado antes de inicializar, llama a initialize() primero");
            throw new Error("[CampusService] No inicializado. Llama a initialize() primero.");
        }
    }

    // Stats para debugging y health checks.
    getStats() {
        const stats = {
            ready: this.isReady,
            total_buildings: this.buildings.size,
            buildings_with_synonyms: Array.from(this.buildings.values()).filter(b => b.synonyms.length > 0).length,
        };

        logger.debug(stats, "CampusService stats");

        return stats;
    }
}

// Exportar como singleton — se comparte entre herramientas y prompts
export const CampusService = new _CampusService();