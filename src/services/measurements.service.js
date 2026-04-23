// Rutas para obtener la información de la OpenAPI.
import axios from 'axios';
import dotenv from "dotenv";
import { DateTime } from "luxon";
import logger from "../config/logger.js";

// Función para poder poner las fechas en formato español (DD-MM-YYYY) o en formato ISO (YYYY-MM-DD) y convertirlas a UTC para la consulta a la API.
function parseDate(dateStr, isEnd = false, timezone = "Europe/Madrid") {
    // Fecha: (15-12-25) o (2025-12-15) o (2025-12-15T14:30:00Z)
    if (!dateStr) return null;

    // Si ya es ISO 8601 (YYYY-MM-DD)
    if (dateStr.includes("T")) return dateStr;

    // Si es Formato DD-MM-YYYY → convertir a YYYY-MM-DD
    if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
        const [day, month, year] = dateStr.split("-");
        dateStr = `${year}-${month}-${day}`;
    }

    // Crear la fecha en la zona horaria local y convertir a UTC (Inverno o Verano)
    if (isEnd) {
        return DateTime.fromISO(`${dateStr}T23:59:59`, { zone: timezone }).toUTC().toISO();
    } else {
        return DateTime.fromISO(`${dateStr}T00:00:00`, { zone: timezone }).toUTC().toISO();
    }
}

// Helper interno para no repetir el log en cada función
async function apiCall(label, collection, fn) {
    const start = Date.now();
    logger.debug({ service: label, collection }, "Llamada API externa");
    try {
        const result = await fn();

        // La API devuelve { error: true } con status 200 en algunos casos
        if (result?.error) {
            logger.warn({
                service: label,
                collection,
                status: result.status,
                message: result.message,
                ms: Date.now() - start
            }, "API externa ha devuelto error logico");
            return result;
        }

        const preview = JSON.stringify(result).slice(0, 150);
        logger.debug({ service: label, collection, ms: Date.now() - start, preview }, "API externa OK");
        return result;

    } catch (error) {
        if (error.response) {
            // La API respondió pero con un código de error HTTP (4xx, 5xx)
            logger.warn({
                service: label,
                collection,
                status: error.response.status,
                message: error.response.data?.message,
                ms: Date.now() - start
            }, "API externa ha respondido con error HTTP");
            return { error: true, status: error.response.status, message: error.response.data?.message || JSON.stringify(error.response.data) };
        }

        // La API no es alcanzable (timeout, red caída, DNS, etc.)
        logger.error({ service: label, collection, err: error, ms: Date.now() - start }, "API externa no disponible");
        return { error: true, message: error.message };
    }
}

// Dependiendo del token que se use, se podrá acceder a la información de una colección u otra.
export const OpenApiMeasurements = {

    async fetchOpenApiInfo(collection = "energy") {
        return apiCall("fetchOpenApiInfo", collection, () =>
            axios.get(`${process.env.KUNNA_ENDPOINT_API}/openapi/measurements/info`, {
                headers: { 'x-token-open-api': process.env[`KUNNA_API_TOKEN_${collection.toUpperCase()}`] }
            }).then(r => r.data)
        );
    },

    async fetchOpenApiDevices(collection = "energy") {
        return apiCall("fetchOpenApiDevices", collection, () =>
            axios.get(`${process.env.KUNNA_ENDPOINT_API}/openapi/measurements/devices`, {
                headers: { 'x-token-open-api': process.env[`KUNNA_API_TOKEN_${collection.toUpperCase()}`] }
            }).then(r => r.data)
        );
    },

    async fetchOpenApiMagnitudes(collection = "energy", device_id = null) {
        return apiCall("fetchOpenApiMagnitudes", collection, () =>
            axios.get(`${process.env.KUNNA_ENDPOINT_API}/openapi/measurements/magnitudes`, {
                headers: { 'x-token-open-api': process.env[`KUNNA_API_TOKEN_${collection.toUpperCase()}`] },
                params: device_id ? { device_id } : {}
            }).then(r => r.data)
        );
    },

    async fetchOpenApiMetadaDevice(collection = "energy", device_id = null) {
        return apiCall("fetchOpenApiMetadaDevice", collection, () =>
            axios.get(`${process.env.KUNNA_ENDPOINT_API}/openapi/measurements/metadata/${device_id}`, {
                headers: { 'x-token-open-api': process.env[`KUNNA_API_TOKEN_${collection.toUpperCase()}`] }
            }).then(r => r.data)
        );
    },

    async fetchOpenApiQueryData({ collection = "energy", device_id = null, magnitude = null, tags = [], start = null, end = null, last = 60, timezone = "Europe/Madrid", limit = 1000, include_metadata = false, export_format = "json" } = {}) {
        const filters = [];
        if (device_id) filters.push({ field: "device_id", values: [device_id] });
        if (magnitude) filters.push({ field: "magnitude", values: [magnitude] });

        const parsedStart = parseDate(start, false, timezone);
        const parsedEnd = parseDate(end, true, timezone);

        let time_range;
        if (parsedStart && parsedEnd) {
            // Fechas absolutas: ya convertidas a UTC por parseDate
            time_range = { start: parsedStart, end: parsedEnd, timezone };
        } else {
            // Relativo: calcular start/end explícitamente en UTC para evitar ambigüedades con "last" y zonas horarias
            const now = DateTime.now().setZone(timezone);
            const from = now.minus({ minutes: last ?? 60 });
            time_range = { start: from.toUTC().toISO(), end: now.toUTC().toISO(), timezone };
        }

        const body = {
            time_range,
            ...(filters.length > 0 && { filters }),
            ...(tags && tags.length > 0 && { tags }),
            options: { limit, ...(include_metadata && { include_metadata: true }) },
            export_format
        };

        return apiCall("fetchOpenApiQueryData", collection, () =>
            axios.post(
                `${process.env.KUNNA_ENDPOINT_API}/openapi/measurements/query/data`,
                body,
                {
                    headers: {
                        'x-token-open-api': process.env[`KUNNA_API_TOKEN_${collection.toUpperCase()}`],
                        'Content-Type': 'application/json'
                    }
                }
            ).then(r => r.data)
        );
    },

    async fetchOpenApiQueryAggregation({ collection = "energy", device_id = null, magnitude = null, tags = [], start = null, end = null, last = 60, timezone = "Europe/Madrid", operations = "avg", interval_minutes = 60, group_by = "device_id", export_format = "json" } = {}) {
        const filters = [];
        if (device_id) filters.push({ field: "device_id", values: [device_id] });
        if (magnitude) filters.push({ field: "magnitude", values: [magnitude] });

        const parsedStart = parseDate(start, false, timezone);
        const parsedEnd = parseDate(end, true, timezone);

        let time_range;
        if (parsedStart && parsedEnd) {
            // Fechas absolutas: ya convertidas a UTC por parseDate
            time_range = { start: parsedStart, end: parsedEnd, timezone };
        } else {
            // Relativo: calcular start/end explícitamente en UTC
            const now = DateTime.now().setZone(timezone);
            const from = now.minus({ minutes: last ?? 60 });
            time_range = { start: from.toUTC().toISO(), end: now.toUTC().toISO(), timezone };
        }

        const body = {
            time_range,
            aggregation: { operations, interval_minutes, group_by },
            ...(filters.length > 0 && { filters }),
            ...(tags && tags.length > 0 && { tags }),
            export_format
        };

        return apiCall("fetchOpenApiQueryAggregation", collection, () =>
            axios.post(
                `${process.env.KUNNA_ENDPOINT_API}/openapi/measurements/query/data/aggregation`,
                body,
                {
                    headers: {
                        'x-token-open-api': process.env[`KUNNA_API_TOKEN_${collection.toUpperCase()}`],
                        'Content-Type': 'application/json'
                    }
                }
            ).then(r => r.data)
        );
    },
};