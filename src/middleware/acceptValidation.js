import logger from "../config/logger.js";


// Validacion del header Accept segun la spec MCP Streamable HTTP:
export function validateAcceptHeader(req, res, next) {
    const acceptsJson = req.accepts("application/json");
    const acceptsSse  = req.accepts("text/event-stream");

    if (req.method === "POST" && (!acceptsJson || !acceptsSse)) {
        logger.warn(
            { ip: req.ip, accept: req.headers.accept ?? "(vacio)" },
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
            { ip: req.ip, accept: req.headers.accept ?? "(vacio)" },
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