import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to mark endpoints as exempt from JwtAuthGuard and PermissionsGuard.
 * Restricted to the 5 approved public endpoints:
 * 1. POST /tenants
 * 2. POST /auth/login
 * 3. POST /sync/webhook/:source
 * 4. GET /health/live
 * 5. GET /health/ready
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
