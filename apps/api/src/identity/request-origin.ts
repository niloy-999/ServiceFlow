import { ForbiddenException, InternalServerErrorException } from "@nestjs/common";

export function assertFrontendOrigin(origin: string | undefined): void {
  const webAppUrl = process.env.WEB_APP_URL;

  if (!webAppUrl) {
    throw new InternalServerErrorException("The web application URL is not configured.");
  }

  let frontendOrigin: string;

  try {
    const parsedUrl = new URL(webAppUrl);

    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.pathname !== "/" ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      throw new Error("Invalid frontend origin.");
    }

    if (process.env.NODE_ENV === "production" && parsedUrl.protocol !== "https:") {
      throw new Error("WEB_APP_URL must use HTTPS in production.");
    }

    frontendOrigin = parsedUrl.origin;
  } catch {
    throw new InternalServerErrorException("The web application URL is invalid.");
  }

  if (!origin || origin !== frontendOrigin) {
    throw new ForbiddenException("The request origin is not allowed.");
  }
}
