import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

function getFrontendOrigin(): string {
  const webAppUrl = process.env.WEB_APP_URL;

  if (!webAppUrl) {
    throw new Error("WEB_APP_URL must be configured.");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(webAppUrl);
  } catch {
    throw new Error("WEB_APP_URL must be a valid absolute URL.");
  }

  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("WEB_APP_URL must contain only an HTTP or HTTPS origin.");
  }

  if (process.env.NODE_ENV === "production" && parsedUrl.protocol !== "https:") {
    throw new Error("WEB_APP_URL must use HTTPS in production.");
  }

  return parsedUrl.origin;
}

async function bootstrap() {
  const frontendOrigin = getFrontendOrigin();
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api/v1");

  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => callback(null, requestOrigin === frontendOrigin),
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, "127.0.0.1");

  console.log(`ServiceFlow API listening on port ${port}`);
}

void bootstrap();
