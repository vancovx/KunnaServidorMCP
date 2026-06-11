// src/middleware/auth.js
import { timingSafeEqual } from "crypto";
import logger from "../config/logger.js";

/**
 * Middleware de autenticación Bearer para el endpoint /mcp.
 * El token esperado se define en la variable de entorno MCP_AUTH_TOKEN.
 */
export function bearerAuth(req, res, next) {
    const expected = process.env.MCP_AUTH_TOKEN;

    // Fail-closed: si el servidor está mal configurado, denegamos en vez de
    // dejar el endpoint abierto silenciosamente (principio de seguro por defecto).
    if (!expected) {
        logger.error("MCP_AUTH_TOKEN no definido: peticion rechazada (fail-closed)");
        return res.status(500).json({ error: "Server auth misconfigured" });
    }

    // Express normaliza los headers a minúsculas
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
        // WWW-Authenticate en el 401 es lo que exige RFC 6750 y la spec MCP;
        // ademas permite a clientes como Claude detectar que el server pide auth.
        logger.warn({ ip: req.ip, path: req.path }, "AUTH -> Peticion sin Bearer token");
        res.set("WWW-Authenticate", 'Bearer realm="mcp"');
        return res.status(401).json({ error: "Unauthorized" });
    }

    // Comparacion en tiempo constante para evitar timing attacks.
    // timingSafeEqual exige buffers de igual longitud, asi que comparamos
    // primero longitudes (esto solo filtra la longitud, no el contenido).
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    const valid =
        tokenBuf.length === expectedBuf.length &&
        timingSafeEqual(tokenBuf, expectedBuf);

    if (!valid) {
        logger.warn({ ip: req.ip, path: req.path }, "AUTH -> Token invalido");
        res.set("WWW-Authenticate", 'Bearer realm="mcp", error="invalid_token"');
        return res.status(401).json({ error: "Unauthorized" });
    }

    next();
}