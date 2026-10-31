import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables for migration runner
dotenv.config();

/**
 * Migration DataSource CLI configuration.
 *
 * STRICT SECURITY CONVENTION:
 * This DataSource is used EXCLUSIVELY by the TypeORM CLI to run database migrations
 * (e.g. `npm run migration:run`, `npm run migration:revert`).
 *
 * It connects using the administrative schema owner role: `omnistock_migrator`.
 * The runtime application (NestJS DatabaseModule) NEVER loads or uses these credentials!
 */
const AppMigrationDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'omnistock',
  username: process.env.DB_MIGRATOR_USER || 'omnistock_migrator',
  password: process.env.DB_MIGRATOR_PASSWORD || 'MigratorSecurePass123!',
  synchronize: false, // Invariant: synchronize MUST ALWAYS be false
  logging: process.env.NODE_ENV !== 'production',
  migrationsRun: false,
  entities: [path.join(__dirname, '/../../**/*.entity{.ts,.js}')],
  migrations: [path.join(__dirname, '/migrations/*{.ts,.js}')],
  migrationsTableName: 'typeorm_migrations',
});
export { AppMigrationDataSource };
