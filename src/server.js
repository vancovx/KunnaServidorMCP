import express from "express";
import { randomUUID } from "crypto";
import logger from "./config/logger.js";
import { registerTools } from "./tools/registerTool.js";
import { registerPrompts } from "./prompts/registerPrompts.js";
import { registerCampusTools } from "./tools/campusTool.js";
import { securityHeaders, corsPolicy, mcpRateLimiter } from "./middleware/security.js";
import { validateAcceptHeader } from "./middleware/acceptValidation.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingsService } from "./services/embeddings.service.js";
import { bearerAuth } from "./middleware/auth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SessionManager } from "./sessionManager.js";

// Abreviar sessionId: actua como credencial de sesion y no debe persistirse en logs.
function sid(sessionId) {
    return sessionId ? sessionId.slice(0, 8) : "--------";
}

// Instancia del servidor MCP con sus tools y prompts registrados.
export function createMcpServer() {
    const server = new McpServer(
        { name: "KunnaServidorMCP", version: "1.0.0" },
        { capabilities: { tools: {}, prompts: {} } }
    );

    registerTools(server);
    registerCampusTools(server);
    registerPrompts(server);

    return server;
}


//  [1/5] INIT -> crear sesion nueva
async function handleInitialize(req, res, manager) {
    const ip = req.ip;
    const client = req.body?.params?.clientInfo?.name ?? "desconocido";

    let session;
    try {
        session = await manager.createSession();
    } catch (err) {
        logger.error({ ip, err }, "[1/5] INIT -> ERROR creando la sesion");
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
        return;
    }

    logger.info({ sid: sid(session.id), ip, client }, "[1/5] INIT -> Nueva sesion creada");

    const toolNames = Object.keys(session.server._registeredTools ?? {});
    logger.debug(
        { sid: sid(session.id), total: toolNames.length, tools: toolNames },
        "[1/5] INIT -> Tools registradas en sesion"
    );

    try {
        await session.transport.handleRequest(req, res, req.body);
        res.on("finish", () => {
            logger.info(
                { sid: sid(session.id), status: res.statusCode },
                "[1/5] INIT -> sessionId enviado al cliente"
            );
        });
    } catch (err) {
        logger.error({ sid: sid(session.id), err }, "[1/5] INIT -> ERROR en initialize");
        // Si el handshake falla, no dejamos la sesion colgada en el registro.
        await manager.closeSession(session.id, "init-failed");
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
}

//  [5/5] CLOSE -> cierre explicito por DELETE
async function handleDelete(req, res, manager) {
    const incomingSessionId = req.headers["mcp-session-id"];

    if (incomingSessionId && manager.has(incomingSessionId)) {
        await manager.closeSession(incomingSessionId, "client-delete");
        logger.info({ sid: sid(incomingSessionId) }, "[5/5] CLOSE -> Sesion cerrada y eliminada por DELETE");
        return res.status(200).json({ status: "session closed" });
    }

    // Spec MCP: sessionId desconocido -> 404 para que el cliente re-inicialice.
    logger.warn({ sid: sid(incomingSessionId), ip: req.ip }, "[5/5] CLOSE -> DELETE con sesion desconocida");
    return res.status(404).json({ error: "Session not found" });
}

//  Peticiones sobre una sesion ya existente (GET SSE, notifications, tools, etc.)
async function handleSessionRequest(req, res, session) {
    const method = req.body?.method;

    // Cualquier interaccion refresca la actividad de la sesion.
    session.touch();

    // GET /mcp -> canal SSE de notificaciones servidor->cliente.
    if (req.method === "GET") {
        logger.info({ sid: sid(session.id) }, "GET   -> Stream SSE de notificaciones solicitado");
        session.attachStream(req, res);
    }

    // [2/5] READY -> cliente confirma que esta listo
    else if (method === "notifications/initialized") {
        logger.info({ sid: sid(session.id) }, "[2/5] READY -> Cliente confirma conexion, sesion activa");
    }

    // [3/5] TOOLS -> cliente pide lista de herramientas
    else if (method === "tools/list") {
        const toolNames = Object.keys(session.server._registeredTools ?? {});
        logger.info(
            { sid: sid(session.id), total: toolNames.length, tools: toolNames },
            "[3/5] TOOLS -> Enviando lista de herramientas al cliente"
        );
    }

    // [3/5] DISCO -> descubrimiento de prompts y resources
    else if (method === "prompts/list" || method === "resources/list") {
        logger.debug({ sid: sid(session.id), method }, "[3/5] DISCO -> Descubrimiento de capacidades del servidor");
    }

    // [4/5] CALL -> cliente llama a una herramienta
    else if (method === "tools/call") {
        const toolName = req.body?.params?.name ?? "desconocida";
        const start = Date.now();
        logger.info({ sid: sid(session.id), tool: toolName }, "[4/5] CALL  -> Ejecutando herramienta");
        res.on("finish", () => {
            logger.info(
                { sid: sid(session.id), tool: toolName, status: res.statusCode, ms: Date.now() - start },
                "[4/5] RESULT-> Herramienta ejecutada y respuesta enviada"
            );
        });
    }

    // Cualquier otro metodo del protocolo
    else if (method) {
        logger.debug({ sid: sid(session.id), method }, "[?]   PROTO -> Metodo de protocolo");
    }

    // Punto unico de delegacion en el transporte para TODOS los caminos (incluido GET).
    try {
        await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
        logger.error({ sid: sid(session.id), method, err }, "ERROR -> Fallo al procesar peticion de sesion");
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
}

//  Peticion sin sesion (modo stateless): par {server, transport} efimero que
//  SI liberamos al terminar la respuesta (a diferencia del codigo anterior).
async function handleStateless(req, res) {
    const method = req.body?.method;
    const traceId = randomUUID();
    logger.info({ sid: sid(traceId), method }, "[?]   STAT  -> Peticion sin sesion (modo stateless)");

    let server;
    let transport;
    try {
        server = createMcpServer();
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        const cleanup = () => {
            transport.close().catch(() => {});
            server.close().catch(() => {});
        };
        res.on("finish", cleanup);
        res.on("close", cleanup);
    } catch (err) {
        logger.error({ sid: sid(traceId), method, err }, "ERROR -> Fallo en peticion stateless");
        transport?.close().catch(() => {});
        server?.close().catch(() => {});
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
}

//  Arranque del servidor
export async function startMcpServer() {

    // Verificar conectividad con la BD.
    try {
        const total = (await EmbeddingsService.getAllBuildings()).length;
        logger.info({ total }, "Conexion a BD realizada correctamente.");
    } catch (err) {
        logger.fatal({ err: err.message }, "No se puede conectar a PostgreSQL");
        process.exit(1);
    }

    const app = express();
    app.set("trust proxy", 1);

    // TTL de sesiones inactivas (1h), frecuencia de limpieza (10min) y
    // periodo de heartbeat SSE (20s).
    const SESSION_TTL_MS = 60 * 60 * 1000;
    const SESSION_CLEANUP_MS = 10 * 60 * 1000;
    const HEARTBEAT_MS = 20000;

    const manager = new SessionManager({
        createMcpServer,
        logger,
        ttlMs: SESSION_TTL_MS,
        cleanupMs: SESSION_CLEANUP_MS,
        heartbeatMs: HEARTBEAT_MS,
    });
    manager.startCleanup();

    app.use(securityHeaders);
    app.use(corsPolicy);

    // Health check con metricas de sesiones/streams para observabilidad.
    app.get("/health", (req, res) => {
        res.json({ status: "ok", ...manager.stats() });
    });

    app.use("/mcp", mcpRateLimiter);
    app.use("/mcp", bearerAuth);
    app.use(express.json());

    app.all("/mcp", validateAcceptHeader, async (req, res) => {
        const method = req.body?.method;
        const incomingSessionId = req.headers["mcp-session-id"];

        // [1/5] INIT
        if (req.method === "POST" && method === "initialize") {
            return handleInitialize(req, res, manager);
        }

        // [5/5] CLOSE (DELETE)
        if (req.method === "DELETE") {
            return handleDelete(req, res, manager);
        }

        // Sesion existente
        if (incomingSessionId && manager.has(incomingSessionId)) {
            return handleSessionRequest(req, res, manager.get(incomingSessionId));
        }

        // Header presente pero sesion desconocida/expirada -> 404 (spec MCP)
        if (incomingSessionId) {
            logger.warn(
                { sid: sid(incomingSessionId), ip: req.ip, method },
                "[?]   STALE -> Mcp-Session-Id desconocido o expirado"
            );
            return res.status(404).json({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Session not found, please re-initialize" },
                id: null,
            });
        }

        // Sin sesion (sin header) -> stateless
        return handleStateless(req, res);
    });

    // Arranque del servidor HTTP.
    const port = process.env.PORT || 3000;
    const httpServer = app.listen(port, "0.0.0.0", () => {
        logger.info({ port, env: process.env.NODE_ENV }, "Servidor MCP listo");
    });

    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 0;
    httpServer.keepAliveTimeout = 120000;
    httpServer.timeout = 0;

    // Apagado ordenado: cerrar todas las sesiones y el servidor HTTP.
    const shutdown = async (signal) => {
        logger.info({ signal }, "Apagando servidor MCP...");
        await manager.disposeAll("shutdown");
        httpServer.close(() => process.exit(0));
        // Salida forzada si algo se queda colgado.
        setTimeout(() => process.exit(0), 5000).unref?.();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    return { app, httpServer, manager };
}