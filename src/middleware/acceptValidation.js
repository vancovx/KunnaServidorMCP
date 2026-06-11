import logger from "../config/logger.js";

// Valida el header Accept según la spec MCP Streamable HTTP:
// POST, debe aceptar application/json Y text/event-stream
// GET, debe aceptar text/event-stream
// DELETE, sin requisito de Accept (no devuelve cuerpo SSE/JSON-RPC)
// Rechazo temprano con 406 para evitar crear sesiones/transports que el SDK rechazaría igualmente más tarde. 
export function validateAcceptHeader(req, res, next) {
    const acceptsJson = req.accepts("application/json");
    const acceptsSse  = req.accepts("text/event-stream");

    if (req.method === "POST" && (!acceptsJson || !acceptsSse)) {
        logger.warn(
            { ip: req.ip, accept: req.headers.accept ?? "(vacío)" },
            "ACCEPT -> POST sin 'application/json, text/event-stream'"
        );
        return res.status(406).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Not Acceptable: client must accept both application/json and text/event-stream",
            },
            id: null,
        });
    }

    if (req.method === "GET" && !acceptsSse) {
        logger.warn(
            { ip: req.ip, accept: req.headers.accept ?? "(vacío)" },
            "ACCEPT -> GET sin 'text/event-stream'"
        );
        return res.status(406).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Not Acceptable: client must accept text/event-stream",
            },
            id: null,
        });
    }

    next();
}