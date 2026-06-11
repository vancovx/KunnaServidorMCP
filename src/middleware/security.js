import helmet from "helmet";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import logger from "../config/logger.js";

const isProd = process.env.NODE_ENV === "production";

// Cabeceras HTTP seguras 
export const securityHeaders = helmet();

// CORS restringido
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

if (allowedOrigins.length === 0) {
    if (isProd) {
        logger.warn("CORS_ALLOWED_ORIGINS no definido en produccion: CORS cerrado (fail-closed)");
    } else {
        logger.warn("CORS_ALLOWED_ORIGINS no definido: CORS abierto a cualquier origen (solo desarrollo)");
    }
}

export const corsPolicy = cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : !isProd,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id", "ngrok-skip-browser-warning"],
    exposedHeaders: ["Mcp-Session-Id"],
    credentials: false,
});

// Rate limiter para /mcp 
export const mcpRateLimiter = rateLimit({
    windowMs: 60 * 1000,        
    limit: 60,                  
    standardHeaders: "draft-7", 
    legacyHeaders: false,       
    handler: (req, res) => {
        logger.warn({ ip: req.ip, path: req.path }, "RATE  -> Limite de peticiones excedido");
        res.status(429).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Too many requests, slow down" },
            id: null,
        });
    },
});