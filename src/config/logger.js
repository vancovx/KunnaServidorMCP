import pino from "pino";
import pretty from "pino-pretty";

const stream = pretty({
    colorize: true,
    translateTime: "SYS:HH:MM:ss",
    ignore: "pid,hostname",
    levelFirst: true,
    customColors: "fatal:bgRed,error:red,warn:yellow,info:cyan,debug:gray,trace:white",
    useOnlyCustomProps: false,
    messageFormat: (log, messageKey) => {
        const msg = log[messageKey];
        // Nivel 20 = debug -> gris oscuro
        if (log.level === 20) return `\x1b[90m${msg}\x1b[0m`;
        return msg;
    },
    destination: process.stderr 
});

const logger = pino(
    {
        level: process.env.LOG_LEVEL || "debug",
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                destination: 2, // 2 siempre es stderr
                // Copia aquí el resto de tus opciones de pretty si quieres mantenerlas
            }
        }
    },
    stream
);

export default logger;