import {
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { TenantInterceptor } from '../../../src/common/interceptors/tenant.interceptor';

describe('TenantInterceptor Unit Tests (T014)', () => {
  let interceptor: TenantInterceptor;
  let mockDataSource: any;
  let mockQueryRunner: any;

  const validTenantId = 'a0000000-0000-4000-8000-000000000001';
  const validUserId = '10000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    mockQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    interceptor = new TenantInterceptor(mockDataSource as unknown as DataSource);
  });

  const createMockContext = (request: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  const mockCallHandler: CallHandler = {
    handle: () => of('success'),
  };

  it('allows exempt routes (isTenantExempt = true) to pass through without JWT check', async () => {
    const request = { isTenantExempt: true };
    const context = createMockContext(request);

    const result$ = await interceptor.intercept(context, mockCallHandler);
    const result = await result$.toPromise();
    expect(result).toBe('success');
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('throws 401 AUTH_UNAUTHORIZED when user is missing or lacks tenant_id / sub', async () => {
    const request = { user: null };
    const context = createMockContext(request);

    await expect(interceptor.intercept(context, mockCallHandler)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 403 TENANT_MEMBERSHIP_REQUIRED when tenant_id or sub is malformed UUID', async () => {
    const request = { user: { tenant_id: 'not-a-uuid', sub: validUserId } };
    const context = createMockContext(request);

    await expect(interceptor.intercept(context, mockCallHandler)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws 403 TENANT_MEMBERSHIP_REQUIRED when user is not found in database', async () => {
    const request = { user: { tenant_id: validTenantId, sub: validUserId } };
    const context = createMockContext(request);

    // Mock SET LOCAL then empty user query
    mockQueryRunner.query.mockImplementation((sql: string) => {
      if (sql.includes('SET LOCAL')) return Promise.resolve();
      if (sql.includes('SELECT')) return Promise.resolve([]);
      return Promise.resolve();
    });

    await expect(interceptor.intercept(context, mockCallHandler)).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('throws 403 TENANT_MEMBERSHIP_REQUIRED when user is inactive in database', async () => {
    const request = { user: { tenant_id: validTenantId, sub: validUserId } };
    const context = createMockContext(request);

    mockQueryRunner.query.mockImplementation((sql: string) => {
      if (sql.includes('SET LOCAL')) return Promise.resolve();
      if (sql.includes('SELECT')) {
        return Promise.resolve([
          {
            id: validUserId,
            tenant_id: validTenantId,
            email: 'user@test.com',
            role: 'VIEWER',
            is_active: false,
          },
        ]);
      }
      return Promise.resolve();
    });

    await expect(interceptor.intercept(context, mockCallHandler)).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('sets transaction-scoped SET LOCAL and attaches database-loaded user context on success', async () => {
    const request: any = {
      user: { tenant_id: validTenantId, sub: validUserId, role: 'STALE_JWT_ROLE' },
      body: { tenant_id: 'client-supplied-should-be-ignored' },
    };
    const context = createMockContext(request);

    mockQueryRunner.query.mockImplementation((sql: string) => {
      if (sql.includes('SET LOCAL')) {
        expect(sql).toContain(validTenantId);
        return Promise.resolve();
      }
      if (sql.includes('SELECT')) {
        return Promise.resolve([
          {
            id: validUserId,
            tenant_id: validTenantId,
            email: 'active@test.com',
            role: 'ADMIN', // Authoritative DB role differs from stale JWT claim
            is_active: true,
          },
        ]);
      }
      return Promise.resolve();
    });

    const result$ = await interceptor.intercept(context, mockCallHandler);
    const result = await result$.toPromise();
    expect(result).toBe('success');

    expect(request.authenticatedUser).toEqual({
      id: validUserId,
      tenant_id: validTenantId,
      email: 'active@test.com',
      role: 'ADMIN',
      is_active: true,
    });
    expect(request.tenantId).toBe(validTenantId);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });
});
