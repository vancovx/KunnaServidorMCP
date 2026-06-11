import pino from "pino";
import pretty from "pino-pretty";

const isProd = process.env.NODE_ENV === "production";

const devStream = pretty({
    colorize: true,
    translateTime: "SYS:HH:MM:ss",
    ignore: "pid,hostname",
    levelFirst: true,
    customColors: "fatal:bgRed,error:red,warn:yellow,info:cyan,debug:gray,trace:white",
    messageFormat: (log, messageKey) => {
        const msg = log[messageKey];
        if (log.level === 20) return `\x1b[90m${msg}\x1b[0m`; // debug en gris
        return msg;
    },
    destination: process.stdout, 
});

const logger = pino(
    {
        level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
        base: undefined, 
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
            paths: ["req.headers.authorization", "headers.authorization", "*.token", "*.password"],
            censor: "[REDACTED]",
        },
    },
    isProd ? undefined : devStream // prod: JSON plano a stdout; dev: pretty
);

export default logger;