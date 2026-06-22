import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Abrevia el sessionId para logs: actua como credencial de sesion y no debe
// persistirse entero (igual que el helper sid() del resto del proyecto).
function sid(sessionId) {
    return sessionId ? sessionId.slice(0, 8) : "--------";
}


export class McpSession {
    constructor({ id, server, transport, heartbeatMs, logger }) {
        this.id = id;
        this.server = server;
        this.transport = transport;
        this.heartbeatMs = heartbeatMs;
        this.logger = logger;

        this.createdAt = Date.now();
        this.lastActivity = Date.now();

        // Streams SSE activos. Cada entrada: { req, res, heartbeat, onClose }.
        // todos para que ninguno quede huerfano.
        this.streams = new Set();

        // Callback inyectado por el SessionManager para eliminar la sesion del mapa cuando se libera. Unico punto que "saca" la sesion del registro.
        this.onDispose = null;

        this.disposed = false;
    }

    static async create({ id, createMcpServer, heartbeatMs, logger }) {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => id,
        });

        await server.connect(transport);

        const session = new McpSession({ id, server, transport, heartbeatMs, logger });

        // Si el transporte se cierra por su cuenta liberamos la sesion.
        const sdkOnClose = transport.onclose;
        transport.onclose = () => {
            try { sdkOnClose?.(); } catch {  }
            session.dispose("transport-onclose").catch(() => {});
        };

        return session;
    }

    // Refresca la marca de actividad.
    touch() {
        this.lastActivity = Date.now();
    }

    // Registra un stream SSE (GET /mcp) sobre esta sesion: arranca su heartbeat y engancha la limpieza a los eventos de cierre de la conexion.
    attachStream(req, res) {
        const entry = { req, res, heartbeat: null, onClose: null };

        // Postman / proxies / ngrok matan streams idle: enviamos un comentario SSE periodico para mantener viva la conexion.
        entry.heartbeat = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
                this.detachStream(entry);
                return;
            }
            try {
                res.write(": heartbeat\n\n");
                this.touch();
            } catch (err) {
                this.logger.warn(
                    { sid: sid(this.id), err: err.message },
                    "GET   -> Heartbeat fallido, cerrando stream"
                );
                this.detachStream(entry);
            }
        }, this.heartbeatMs);

        const onClose = () => this.detachStream(entry);
        entry.onClose = onClose;
        res.on("close", onClose);
        res.on("finish", onClose);
        req.on("close", onClose);

        this.streams.add(entry);
        this.touch();

        this.logger.info(
            { sid: sid(this.id), streams: this.streams.size },
            "GET   -> Stream SSE de notificaciones abierto, iniciando heartbeat"
        );

        return entry;
    }

    // Desregistra un stream
    detachStream(entry) {
        if (!this.streams.has(entry)) return;

        clearInterval(entry.heartbeat);
        this._removeStreamListeners(entry);
        this.streams.delete(entry);

        this.logger.info(
            { sid: sid(this.id), streams: this.streams.size },
            "GET   -> Stream SSE cerrado, heartbeat detenido"
        );
    }

    _removeStreamListeners(entry) {
        if (!entry.onClose) return;
        entry.res.off?.("close", entry.onClose);
        entry.res.off?.("finish", entry.onClose);
        entry.req.off?.("close", entry.onClose);
    }

    hasActiveStreams() {
        return this.streams.size > 0;
    }


    isExpired(now, ttlMs) {
        if (this.hasActiveStreams()) return false;
        return now - this.lastActivity > ttlMs;
    }

    ///UNICO punto de liberacion de recursos.
    async dispose(reason = "manual") {
        if (this.disposed) return;
        this.disposed = true;

        // 1. Parar y soltar todos los streams SSE.
        for (const entry of this.streams) {
            clearInterval(entry.heartbeat);
            this._removeStreamListeners(entry);
        }
        this.streams.clear();

        // 2. Cerrar transporte y servidor
        try {
            await this.transport.close();
        } catch (err) {
            this.logger.warn({ sid: sid(this.id), err: err.message }, "CLOSE -> Error cerrando transporte");
        }
        try {
            await this.server.close();
        } catch (err) {
            this.logger.warn({ sid: sid(this.id), err: err.message }, "CLOSE -> Error cerrando servidor MCP");
        }

        // 3. Notificar al registro para que retire la sesion.
        this.onDispose?.(this.id);

        this.logger.info({ sid: sid(this.id), reason }, "[5/5] CLOSE -> Sesion liberada");
    }
}


// Gestiona el ciclo de vida del conjunto de sesiones MCP: creacion, acceso, cierre explicito y barrido periodico de las expiradas.
export class SessionManager {
    constructor({ createMcpServer, logger, ttlMs, cleanupMs, heartbeatMs }) {
        this.createMcpServer = createMcpServer;
        this.logger = logger;
        this.ttlMs = ttlMs;
        this.cleanupMs = cleanupMs;
        this.heartbeatMs = heartbeatMs;

        this.sessions = new Map(); // sessionId -> McpSession
        this.cleanupInterval = null;
    }

    has(id) {
        return this.sessions.has(id);
    }

    get(id) {
        return this.sessions.get(id) ?? null;
    }

    //Crea una sesion nueva, la registra y devuelve la instancia.
    async createSession() {
        const id = randomUUID();
        const session = await McpSession.create({
            id,
            createMcpServer: this.createMcpServer,
            heartbeatMs: this.heartbeatMs,
            logger: this.logger,
        });

        // Unico punto que retira la sesion del Map.
        session.onDispose = (sessionId) => this.sessions.delete(sessionId);

        this.sessions.set(id, session);
        return session;
    }

    // Cierre explicito (p. ej. DELETE del cliente). dispose() retira del Map.
    async closeSession(id, reason = "delete") {
        const session = this.sessions.get(id);
        if (!session) return false;
        await session.dispose(reason);
        return true;
    }

    startCleanup() {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => {
            this.sweep().catch((err) =>
                this.logger.warn({ err: err.message }, "Cleanup de sesiones fallido")
            );
        }, this.cleanupMs);
        this.cleanupInterval.unref?.();
    }

    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    // Libera las sesiones expiradas (inactivas y SIN streams SSE vivos).
    async sweep() {
        const now = Date.now();
        const expired = [...this.sessions.values()].filter((s) => s.isExpired(now, this.ttlMs));

        await Promise.all(
            expired.map((s) => {
                this.logger.info({ sid: sid(s.id) }, "Sesion expirada por inactividad, eliminada");
                return s.dispose("ttl-expired").catch(() => {});
            })
        );

        if (expired.length > 0) {
            this.logger.debug(
                { removed: expired.length, remaining: this.sessions.size },
                "Cleanup de sesiones completado"
            );
        }
    }

    // Cierra todas las sesiones (apagado ordenado del servidor).
    async disposeAll(reason = "shutdown") {
        this.stopCleanup();
        await Promise.all([...this.sessions.values()].map((s) => s.dispose(reason).catch(() => {})));
    }

    // Metricas para /health: numero de sesiones y de streams SSE abiertos.
    stats() {
        let streams = 0;
        for (const session of this.sessions.values()) {
            streams += session.streams.size;
        }
        return { sessions: this.sessions.size, streams };
    }
}