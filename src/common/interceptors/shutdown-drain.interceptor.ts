import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ShutdownDrainService } from '../services/shutdown-drain.service';

@Injectable()
export class ShutdownDrainInterceptor implements NestInterceptor {
  constructor(private readonly shutdownDrainService: ShutdownDrainService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (this.shutdownDrainService.isShuttingDown) {
      // During graceful shutdown, reject new HTTP requests immediately
      throw new ServiceUnavailableException({
        statusCode: 503,
        error_code: 'SERVER_SHUTTING_DOWN',
        message: 'Server is currently shutting down and draining active in-flight requests',
      });
    }

    let resolvePromise!: () => void;
    const requestPromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    this.shutdownDrainService.trackHttpRequest(requestPromise);

    return new Observable((subscriber) => {
      const subscription = next.handle().subscribe({
        next: (val) => subscriber.next(val),
        error: (err) => {
          resolvePromise();
          subscriber.error(err);
        },
        complete: () => {
          resolvePromise();
          subscriber.complete();
        },
      });

      return () => {
        resolvePromise();
        subscription.unsubscribe();
      };
    });
  }
}
