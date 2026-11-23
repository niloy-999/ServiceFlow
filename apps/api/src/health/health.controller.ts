import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("live")
  live() {
    return {
      status: "ok",
      service: "serviceflow-api",
    };
  }

  @Get("ready")
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      status: "ok",
      service: "serviceflow-api",
      database: "ok",
    };
  }

  @Get()
  async check() {
    return this.ready();
  }
}
