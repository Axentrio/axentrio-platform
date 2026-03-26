import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSuperAdminRole1774486770058 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add super_admin to the user role enum
    // TypeORM generates enum names as: <table>_<column>_enum
    await queryRunner.query(`
      ALTER TYPE users_role_enum ADD VALUE IF NOT EXISTS 'super_admin' BEFORE 'admin'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL doesn't support removing enum values directly.
    // To roll back, create a new type without super_admin and migrate the column.
    // For safety, this is a no-op. Demote super_admin users before rollback.
  }
}
