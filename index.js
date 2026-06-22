import 'dotenv/config';
import logger from "./src/config/logger.js";
import { startMcpServer } from "./src/server.js";

// Esto no se puede quitar hasta que la empresa de los certificados lo arregle.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Errores no controlados a nivel de proceso
process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException -> proceso terminado");
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
});

startMcpServer().catch((error) => {
    logger.fatal({ err: error }, "Error fatal al iniciar el servidor MCP");
    process.exit(1);
});