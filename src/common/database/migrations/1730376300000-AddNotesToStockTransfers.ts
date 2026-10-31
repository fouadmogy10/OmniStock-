import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotesToStockTransfers1730376300000 implements MigrationInterface {
  name = 'AddNotesToStockTransfers1730376300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stock_transfers
        ADD COLUMN IF NOT EXISTS notes TEXT;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE stock_transfers
        DROP COLUMN IF EXISTS notes;
    `);
  }
}
