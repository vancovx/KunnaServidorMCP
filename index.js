import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import logger from "./src/config/logger.js";
import { registerTools } from "./src/tools/registerTool.js";
import { registerPrompts } from "./src/prompts/registerPrompts.js";
import { EmbeddingsService } from "./src/services/embeddings.service.js";
import { registerCampusTools } from "./src/tools/campusTool.js";
import { CampusService } from "./src/services/campus.service.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; 
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"; 
import { randomUUID } from "crypto";
import { join } from 'path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
dotenv.config({ path: join(process.cwd(), 'src/config/.env'), quiet: true });

// Errores no controlados
process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException — proceso terminado");
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
});


function extractUserQuery(body) {
    try {
        const messages = body?.messages ?? [];
        const userMessages = messages.filter(m => m.role === "user");
        if (userMessages.length === 0) return null;

        const last = userMessages[userMessages.length - 1];
        const content = last?.content;

        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.find(c => c.type === "text")?.text ?? null;
        if (content?.type === "text") return content.text;

        return null;
    } catch {
        return null;
    }
}


function createMcpServer(relevantToolNames = null) {
    const server = new McpServer(
        { name: "mcp-server1-prueba", version: "1.0.0" },
        { capabilities: { tools: {}, prompts: {} } }
    );

    registerTools(server, relevantToolNames);
    registerCampusTools(server);
    registerPrompts(server);

    return server;
}


async function startMcpServer() {

    await CampusService.initialize();
    
    if (process.env.NODE_ENV === "production") {

        const app = express();

        app.use(cors({
            origin: '*',
            methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
            allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id'],
            exposedHeaders: ['Mcp-Session-Id'],
            credentials: false
        }));

        app.options('/mcp', cors());
        app.use(express.json());

        app.get("/health", (req, res) => {
            res.json({ status: "ok" });
        });

        app.get("/mcp", (req, res) => {
            const server = createMcpServer();
            
            const tools = Object.entries(server._registeredTools).map(([name, tool]) => ({
                name,
                description: tool.description || "",
                inputSchema: tool.inputSchema || { type: "object", properties: {} }
            }));

            logger.trace({ toolCount: tools.length }, "Descubrimiento de herramientas");

            res.json({
                name: "mcp-server1-prueba",
                version: "1.0.0",
                protocolVersion: "2026-11-05",
                capabilities: {
                    tools: { listChanged: true },
                    prompts: { listChanged: true }
                },
                tools
            });
        });

        app.post("/mcp", async (req, res) => {
            const sessionId = randomUUID();
            const ip = req.ip;
            let relevantToolNames = null;

            logger.info({ sessionId, ip }, "Agente conectado");

            try {
                const userQuery = extractUserQuery(req.body);

                if (userQuery) {
                    const shortQuery = userQuery.slice(0, 80);
                    const relevantTools = await EmbeddingsService.findRelevantTools(userQuery, 4, 0.35);

                    if (relevantTools.length > 0) {
                        relevantToolNames = relevantTools.map(t => t.nombre);
                        logger.info(
                            { sessionId, query: shortQuery, tools: relevantToolNames },
                            "Tools seleccionadas por búsqueda semantica"
                        );
                    } else {
                        logger.warn(
                            { sessionId, query: shortQuery },
                            "Sin coincidencias semanticas — registrando todas las tools"
                        );
                    }
                }
            } catch (err) {
                logger.error({ sessionId, err }, "Error en busqueda semantica — usando todas las tools");
            }

            const server = createMcpServer(relevantToolNames);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);

            res.on("finish", () => {
                logger.info({ sessionId, statusCode: res.statusCode }, "Sesion finalizada");
            });
        });

        app.delete("/mcp", (req, res) => {
            logger.debug({ ip: req.ip }, "Sesión cerrada por el agente");
            res.status(200).json({ status: "session closed" });
        });

        const port = process.env.PORT || 3000;
        app.listen(port, '0.0.0.0', () => {
            logger.info({ port, env: process.env.NODE_ENV }, "Express + MCP iniciado");
        });

    } else if (process.env.NODE_ENV === "development") {
        const server = createMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        logger.info("Servidor MCP iniciado en modo STDIO");
    }
}

startMcpServer().catch((error) => {
    logger.fatal({ err: error }, "Error fatal al iniciar el servidor MCP");
    process.exit(1);
});