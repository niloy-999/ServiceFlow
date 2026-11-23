import { HttpException, type LoggerService, type NestInterceptor } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { catchError, finalize, throwError } from "rxjs";

interface HttpRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  requestId?: string;
  baseUrl?: string;
  route?: { path?: string };
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
}

export class HttpRequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {}

  intercept(
    context: Parameters<NestInterceptor["intercept"]>[0],
    next: Parameters<NestInterceptor["intercept"]>[1],
  ) {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const requestId = randomUUID();
    const method = request.method ?? "UNKNOWN";
    const path = request.route?.path
      ? `${request.baseUrl ?? ""}${request.route.path}`
      : "unmatched";
    const startedAt = Date.now();
    let errorType: string | undefined;
    let errorStatus: number | undefined;

    request.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);

    return next.handle().pipe(
      catchError((error: unknown) => {
        errorType =
          error instanceof HttpException
            ? "HttpException"
            : error instanceof Error
              ? "Error"
              : "UnknownError";
        errorStatus = error instanceof HttpException ? error.getStatus() : 500;
        this.logger.error({
          event: "http_request_error",
          requestId,
          method,
          path,
          statusCode: errorStatus,
          errorType,
          durationMs: Date.now() - startedAt,
        });
        return throwError(() => error);
      }),
      finalize(() => {
        this.logger.log({
          event: "http_request_completed",
          requestId,
          method,
          path,
          statusCode: errorStatus ?? response.statusCode,
          outcome: errorType ? "error" : "success",
          durationMs: Date.now() - startedAt,
        });
      }),
    );
  }
}
