"use strict";

const pino = require("pino");
const config = require("./config");

const transport = config.isProd
  ? undefined
  : {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    };

const logger = pino({
  level: config.logLevel,
  base: { service: "real-estate-rag" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "*.token",
    ],
    remove: true,
  },
  transport,
});

module.exports = logger;
