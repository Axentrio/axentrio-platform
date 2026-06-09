/**
 * MobileDevice Entity
 * Registered push targets for the mobile app. One row per device/push token.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('mobile_devices')
@Index(['tenantId', 'userId'])
export class MobileDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'clerk_user_id' })
  clerkUserId?: string;

  @Column({ type: 'varchar', length: 255, unique: true, name: 'expo_push_token' })
  expoPushToken!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'native_token' })
  nativeToken?: string;

  /** 'ios' | 'android' */
  @Column({ type: 'varchar', length: 16 })
  platform!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'device_id' })
  deviceId?: string;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'app_version' })
  appVersion?: string;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'build_number' })
  buildNumber?: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'runtime_version' })
  runtimeVersion?: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  locale?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone?: string;

  @Column({ type: 'varchar', length: 24, nullable: true, name: 'permission_status' })
  permissionStatus?: string;

  /** 'development' | 'production' (APNs environment) */
  @Column({ type: 'varchar', length: 16, nullable: true })
  environment?: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_seen_at' })
  lastSeenAt?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revokedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
