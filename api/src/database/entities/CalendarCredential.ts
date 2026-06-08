/**
 * CalendarCredential — a bot owner's connected external calendar.
 *
 * Multi-provider (Google + Microsoft) but single-calendar and AT MOST ONE active
 * credential per bot, regardless of provider (the active unique index is keyed on
 * `bot_id` alone). The `calendarId` is both the write target (destination) and
 * the calendar checked for busy times. Tokens are encrypted at rest.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type CalendarProviderType = 'google' | 'microsoft';
export type CalendarCredentialStatus = 'active' | 'revoked';

@Index(['botId'], { unique: true, where: "status = 'active'" })
@Entity('chatbot_calendar_credentials')
export class CalendarCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'bot_id' })
  botId!: string;

  @Column({ type: 'varchar', length: 16, default: 'google' })
  provider!: CalendarProviderType;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: CalendarCredentialStatus;

  @Column({ type: 'varchar', length: 320, name: 'account_email', nullable: true })
  accountEmail?: string | null;

  /**
   * Provider-stable account identity (Microsoft Graph user object id from `/me`;
   * null for Google rows, which identify by `accountEmail`/`calendarId`). Used to
   * build the `mscal:<account_id>` conflict key so it survives an email alias.
   */
  @Column({ type: 'varchar', length: 320, name: 'account_id', nullable: true })
  accountId?: string | null;

  /** Owner must reconnect (refresh failed / consent revoked). Cleared on reconnect. */
  @Column({ type: 'boolean', name: 'reauth_required', default: false })
  reauthRequired!: boolean;

  /** Encrypted OAuth tokens. */
  @Column({ type: 'text', name: 'access_token_enc' })
  accessTokenEnc!: string;

  @Column({ type: 'text', name: 'refresh_token_enc', nullable: true })
  refreshTokenEnc?: string | null;

  @Column({ type: 'timestamptz', name: 'token_expiry', nullable: true })
  tokenExpiry?: Date | null;

  /** Destination + busy-source calendar id ('primary' by default). */
  @Column({ type: 'varchar', length: 320, name: 'calendar_id', default: 'primary' })
  calendarId!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
