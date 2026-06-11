import express from "express";
import cors from "cors";
import logger from "./config/logger.js";
import { registerTools } from "./tools/registerTool.js";
import { registerPrompts } from "./prompts/registerPrompts.js";
import { registerCampusTools } from "./tools/campusTool.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmbeddingsService } from "./services/embeddings.service.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";


// Abreviar sessionId, que actua como credencial de sesion y no debe persistirse en logs
function sid(sessionId) {
    return sessionId ? sessionId.slice(0, 8) : "--------";
}


// Instancia del servidor MCP con sus tools y prompts registrados.
export function createMcpServer(relevantToolNames = null) {
    const server = new McpServer(
        { name: "mcp-server1-prueba", version: "1.0.0" },
        { capabilities: { tools: {}, prompts: {} } }
    );

    registerTools(server);
    registerCampusTools(server);
    registerPrompts(server);

    return server;
}


// Inicializa dependencias y levanta el servidor HTTP (único transporte).
export async function startMcpServer() {

    // Verificar conectividad con la BD
    try {
        const total = (await EmbeddingsService.getAllBuildings()).length;
        logger.info({ total }, "Conexion a BD realizada correctamente.");
    } catch (err) {
        logger.fatal({ err: err.message }, "No se puede conectar a PostgreSQL");
        process.exit(1);
    }

    const app = express();

    // Mapa de sesiones activas: sessionId -> { server, transport, lastActivity }
    const sessions = new Map();

    // TTL de sesiones inactivas (1h) y frecuencia de limpieza (10min)
    const SESSION_TTL_MS = 60 * 60 * 1000;
    const SESSION_CLEANUP_MS = 10 * 60 * 1000;

    // Heartbeat SSE para mantener vivos los streams de notificaciones
    const HEARTBEAT_MS = 20000;

    // CORS, no es muy importante porque no se harán llamadas cross-origin desde el navegador en este ejemplo.
    const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map(o => o.trim())
        .filter(Boolean);

    if (allowedOrigins.length === 0) {
        logger.warn("CORS_ALLOWED_ORIGINS no definido: CORS abierto a cualquier origen (desarrollo)");
    }

    app.use(cors({
        origin: allowedOrigins.length > 0 ? allowedOrigins : true,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id"],
        exposedHeaders: ["Mcp-Session-Id"],
        credentials: false,
    }));

    app.use(express.json());

    app.get("/health", (req, res) => {
        res.json({ status: "ok" });
    });

    app.all("/mcp", async (req, res) => {
        const ip = req.ip;
        const method = req.body?.method;
        const incomingSessionId = req.headers["mcp-session-id"];

        // ── [1/5] INIT -> initialize: crear sesion nueva ───────────────────
        if (req.method === "POST" && method === "initialize") {
            const sessionId = randomUUID();
            const client = req.body?.params?.clientInfo?.name ?? "desconocido";

            logger.info(
                { sid: sid(sessionId), ip, client },
                "[1/5] INIT -> Nueva sesion creada"
            );

            try {
                const server = createMcpServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => sessionId,
                });

                sessions.set(sessionId, { server, transport, lastActivity: Date.now() });

                const toolNames = Object.keys(server._registeredTools ?? {});
                logger.debug(
                    { sid: sid(sessionId), total: toolNames.length, tools: toolNames },
                    "[1/5] INIT -> Tools registradas en sesion"
                );

                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);

                res.on("finish", () => {
                    logger.info(
                        { sid: sid(sessionId), status: res.statusCode },
                        "[1/5] INIT -> sessionId enviado al cliente"
                    );
                });

            } catch (err) {
                logger.error({ sid: sid(sessionId), err }, "[1/5] INIT -> ERROR en initialize");
                if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
            }

            return;
        }

        // ── DELETE -> cerrar sesion ────────────────────────────────────────
        if (req.method === "DELETE") {
            if (incomingSessionId && sessions.has(incomingSessionId)) {
                sessions.delete(incomingSessionId);
                logger.info(
                    { sid: sid(incomingSessionId) },
                    "[5/5] CLOSE -> Sesion cerrada y eliminada"
                );
            }
            return res.status(200).json({ status: "session closed" });
        }

        // ── Peticiones con sesion existente ───────────────────────────────
        if (incomingSessionId && sessions.has(incomingSessionId)) {
            const session = sessions.get(incomingSessionId);
            const { server, transport } = session;

            // Refrescar marca de actividad
            session.lastActivity = Date.now();

            // ── GET /mcp -> stream SSE de notificaciones servidor->cliente
            //    Postman/undici matan streams idle, asi que mandamos
            //    comentarios SSE periodicos para mantener viva la conexion.
            if (req.method === "GET") {
                logger.info(
                    { sid: sid(incomingSessionId) },
                    "GET   -> Stream SSE de notificaciones abierto, iniciando heartbeat"
                );

                const heartbeat = setInterval(() => {
                    if (!res.writableEnded && !res.destroyed) {
                        try {
                            res.write(": heartbeat\n\n");
                        } catch (err) {
                            logger.warn(
                                { sid: sid(incomingSessionId), err: err.message },
                                "GET   -> Heartbeat fallido, deteniendo intervalo"
                            );
                            clearInterval(heartbeat);
                        }
                    } else {
                        clearInterval(heartbeat);
                    }
                }, HEARTBEAT_MS);

                const cleanupHeartbeat = () => {
                    clearInterval(heartbeat);
                    logger.info(
                        { sid: sid(incomingSessionId) },
                        "GET   -> Stream SSE cerrado, heartbeat detenido"
                    );
                };
                res.on("close", cleanupHeartbeat);
                res.on("finish", cleanupHeartbeat);
                req.on("close", cleanupHeartbeat);
            }

            // [2/5] READY -> cliente confirma que esta listo
            if (method === "notifications/initialized") {
                logger.info(
                    { sid: sid(incomingSessionId) },
                    "[2/5] READY -> Cliente confirma conexion, sesion activa"
                );
            }

            // [3/5] TOOLS -> cliente pide lista de herramientas
            else if (method === "tools/list") {
                const toolNames = Object.keys(server._registeredTools ?? {});
                logger.info(
                    { sid: sid(incomingSessionId), total: toolNames.length, tools: toolNames },
                    "[3/5] TOOLS -> Enviando lista de herramientas al cliente"
                );
            }

            // [3/5] DISCO -> descubrimiento de prompts y resources
            else if (method === "prompts/list" || method === "resources/list") {
                logger.debug(
                    { sid: sid(incomingSessionId), method },
                    "[3/5] DISCO -> Descubrimiento de capacidades del servidor"
                );
            }

            // [4/5] CALL -> cliente llama a una herramienta
            else if (method === "tools/call") {
                const toolName = req.body?.params?.name ?? "desconocida";
                const start = Date.now();

                logger.info(
                    { sid: sid(incomingSessionId), tool: toolName },
                    "[4/5] CALL  -> Ejecutando herramienta"
                );

                try {
                    await transport.handleRequest(req, res, req.body);

                    res.on("finish", () => {
                        const ms = Date.now() - start;
                        logger.info(
                            { sid: sid(incomingSessionId), tool: toolName, status: res.statusCode, ms },
                            "[4/5] RESULT-> Herramienta ejecutada y respuesta enviada"
                        );
                    });
                } catch (err) {
                    logger.error({ sid: sid(incomingSessionId), tool: toolName, err }, "[4/5] CALL  -> ERROR ejecutando herramienta");
                    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
                }

                return;
            }

            // Cualquier otro metodo del protocolo
            else if (method) {
                logger.debug(
                    { sid: sid(incomingSessionId), method },
                    "[?]   PROTO -> Metodo de protocolo desconocido recibido"
                );
            }

            try {
                await transport.handleRequest(req, res, req.body);

                res.on("finish", () => {
                    logger.debug(
                        { sid: sid(incomingSessionId), method, status: res.statusCode },
                        "      HTTP  -> Respuesta HTTP completada"
                    );
                });
            } catch (err) {
                logger.error({ sid: sid(incomingSessionId), method, err }, "ERROR -> Fallo al procesar peticion");
                if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
            }

            return;
        }

        // ── Sin sesion -> stateless (clientes simples sin init previo) ────
        const sessionId = randomUUID();
        logger.info(
            { sid: sid(sessionId), method },
            "[?]   STAT  -> Peticion sin sesion (modo stateless)"
        );

        try {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);

            res.on("finish", () => {
                logger.debug(
                    { sid: sid(sessionId), method, status: res.statusCode },
                    "      HTTP  -> Respuesta stateless completada"
                );
            });
        } catch (err) {
            logger.error({ sid: sid(sessionId), method, err }, "ERROR -> Fallo en peticion stateless");
            if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
        }
    });

    // ── Limpieza periodica de sesiones inactivas ──────────────────────────
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        let removed = 0;
        for (const [sessionId, session] of sessions.entries()) {
            if (now - (session.lastActivity ?? 0) > SESSION_TTL_MS) {
                sessions.delete(sessionId);
                removed++;
                logger.info(
                    { sid: sid(sessionId) },
                    "Sesion expirada por inactividad, eliminada"
                );
            }
        }
        if (removed > 0) {
            logger.debug({ removed, remaining: sessions.size }, "Cleanup de sesiones completado");
        }
    }, SESSION_CLEANUP_MS);
    cleanupInterval.unref?.();

    // ── Arranque del servidor HTTP con timeouts adecuados para SSE ────────
    const port = process.env.PORT || 3000;
    const httpServer = app.listen(port, '0.0.0.0', () => {
        logger.info({ port, env: process.env.NODE_ENV }, "Servidor MCP listo");
    });

    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 0;
    httpServer.keepAliveTimeout = 120000;
    httpServer.timeout = 0;
}