import { Injectable, LoggerService } from '@nestjs/common';

const SENSITIVE_KEYS = new Set([
  'password',
  'admin_password',
  'password_hash',
  'authorization',
  'webhook_secret',
  'encrypted_secret',
  'secret_hash',
  'x-sync-signature',
  'webhook_secret_encryption_keys',
]);

export function redactSensitiveData(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  if (typeof data === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = redactSensitiveData(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  return data;
}

@Injectable()
export class StructuredLoggerService implements LoggerService {
  private formatLog(
    level: string,
    message: any,
    context?: string,
    metadata?: Record<string, any>,
  ): string {
    const logObj: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level,
      context: context || 'Application',
      message: typeof message === 'string' ? message : JSON.stringify(redactSensitiveData(message)),
    };

    if (metadata) {
      Object.assign(logObj, redactSensitiveData(metadata));
    }

    return JSON.stringify(logObj);
  }

  log(message: any, context?: string, metadata?: Record<string, any>): void {
    console.log(this.formatLog('info', message, context, metadata));
  }

  error(message: any, trace?: string, context?: string, metadata?: Record<string, any>): void {
    const metaWithTrace = { ...metadata, trace };
    console.error(this.formatLog('error', message, context, metaWithTrace));
  }

  warn(message: any, context?: string, metadata?: Record<string, any>): void {
    console.warn(this.formatLog('warn', message, context, metadata));
  }

  debug(message: any, context?: string, metadata?: Record<string, any>): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.formatLog('debug', message, context, metadata));
    }
  }

  verbose(message: any, context?: string, metadata?: Record<string, any>): void {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatLog('verbose', message, context, metadata));
    }
  }
}
