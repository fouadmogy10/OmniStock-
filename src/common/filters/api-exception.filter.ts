import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * ApiExceptionFilter
 *
 * Enforces canonical JSON error envelope per FR-020:
 * {
 *   "statusCode": number,
 *   "error_code": string,
 *   "message": string,
 *   "details"?: object,
 *   "request_id": string,
 *   "timestamp": string
 * }
 *
 * Suppresses internal stack traces and raw SQL diagnostics on 500 INTERNAL_SERVER_ERROR.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request.headers['x-request-id'] as string) ||
      (request as any).requestId ||
      '00000000-0000-0000-0000-000000000000';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'Internal server error';
    let details: Record<string, any> | undefined = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
        errorCode = this.mapStatusToErrorCode(status);
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        message = resObj.message || exception.message;
        errorCode = resObj.error_code || this.mapStatusToErrorCode(status);
        if (resObj.details) details = resObj.details;
      }
    } else {
      // Unhandled / Internal exception - suppress internal details from response
      this.logger.error(
        `Unhandled Exception on [${request.method}] ${request.url} (Request ID: ${requestId})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      error_code: errorCode,
      message,
      ...(details ? { details } : {}),
      request_id: requestId,
      timestamp: new Date().toISOString(),
    });
  }

  private mapStatusToErrorCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_ERROR';
      case HttpStatus.UNAUTHORIZED:
        return 'AUTH_UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'RESOURCE_NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }
}
