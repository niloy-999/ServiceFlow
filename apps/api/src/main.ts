import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);

  await app.listen(port, "127.0.0.1");

  console.log(`ServiceFlow API listening on port ${port}`);
}

void bootstrap();
