import { readdir, readFile } from "fs/promises";
import { join } from "path";
import logger from "../config/logger.js";


class _CampusService {
    constructor() {
        /** @type {Map<string, BuildingData>} código SIGUA → datos del edificio */
        this.buildings = new Map();

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
                };

                this.buildings.set(props.id, building);
                loaded++;
            } catch (err) {
                logger.error({ file, err }, "Error cargando GeoJSON");
                skipped++;
            }
        }

        this.isReady = true;
        logger.info(
            { loaded, skipped, ms: Date.now() - start },
            "CampusService listo"
        );
    }

    // ─────────────────────────────────────────────────────────
    //  BÚSQUEDA POR CÓDIGO
    // ─────────────────────────────────────────────────────────

    /**
     * Intenta hacer match directo por código SIGUA.
     * Acepta: "0014", "14", "edificio 14", "sigua 0014".
     * Devuelve el edificio público o null si no hay match.
     *
     * @param {string} query
     * @returns {object|null}
     */
    matchByCode(query) {
        this._ensureReady();

        const normalized = this._normalize(query);

        // Si la query es solo dígitos (posiblemente con espacios)
        const digits = normalized.replace(/\s/g, "");
        if (/^\d{1,4}$/.test(digits)) {
            const padded = digits.padStart(4, "0");
            const b = this.buildings.get(padded);
            return b ? this._toPublic(b) : null;
        }

        // Si contiene "edificio 14" o "sigua 0014" o "codigo 14"
        const codePattern = /(?:edificio|sigua|codigo|código)\s*(\d{1,4})/;
        const match = normalized.match(codePattern);
        if (match) {
            const padded = match[1].padStart(4, "0");
            const b = this.buildings.get(padded);
            return b ? this._toPublic(b) : null;
        }

        return null;
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
    //  Funciones varias
    // ─────────────────────────────────────────────────────────

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
        };

        logger.debug(stats, "CampusService stats");

        return stats;
    }
}

// Exportar como singleton — se comparte entre herramientas y prompts
export const CampusService = new _CampusService();