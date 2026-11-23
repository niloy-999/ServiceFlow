import { ConsoleLogger } from "@nestjs/common";

export interface ApiListenConfig {
  host: string;
  port: number;
}

export function createApiLogger(): ConsoleLogger {
  return new ConsoleLogger({
    json: true,
    colors: false,
    redact: [
      "authorization",
      "cookie",
      "email",
      "ipAddress",
      "password",
      "recoveryCode",
      "secret",
      "sessionHash",
      "token",
      "userAgent",
    ],
  });
}

export function getApiListenConfig(
  environment: Record<string, string | undefined> = process.env,
): ApiListenConfig {
  const configuredHost = environment.API_HOST ?? "127.0.0.1";
  const host = configuredHost.trim();

  if (!host || host.length > 253 || /\s/.test(host)) {
    throw new Error("API_HOST must be a non-empty hostname or IP address.");
  }

  const configuredPort = environment.PORT ?? "3001";

  if (!/^\d+$/.test(configuredPort)) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const port = Number(configuredPort);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { host, port };
}
