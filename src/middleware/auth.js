import { timingSafeEqual } from "crypto";
import logger from "../config/logger.js";

// Auth se desactiva si NODE_ENV es "development".
const AUTH_REQUIRED = process.env.NODE_ENV !== "development";

export function bearerAuth(req, res, next) {
    if (!AUTH_REQUIRED) {
        logger.debug({ path: req.path }, "AUTH -> Validacion omitida (desarrollo)");
        return next();
    }

    const expected = process.env.MCP_AUTH_TOKEN;

    if (!expected) {
        logger.error("MCP_AUTH_TOKEN no definido: peticion rechazada (fail-closed)");
        return res.status(500).json({ error: "Server auth misconfigured" });
    }

    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
        logger.warn({
            ip: req.ip,
            path: req.path,
            hasAuthHeader: Boolean(header),
            scheme: scheme || "(vacio)",
            schemeLen: header.length,
        }, "AUTH -> Peticion sin Bearer token");
        res.set("WWW-Authenticate", 'Bearer realm="mcp"');
        return res.status(401).json({ error: "Unauthorized" });
    }

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