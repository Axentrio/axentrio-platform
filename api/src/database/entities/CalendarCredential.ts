/**
 * CalendarCredential — a bot owner's connected external calendar (Phase 1).
 *
 * v1 is Google-only and single-calendar: one active credential per bot, whose
 * `calendarId` is both the write target (destination) and the calendar checked
 * for busy times. Tokens are encrypted at rest. The model can later split into
 * Cal.com-style credential / selected / destination rows for multi-calendar.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type CalendarProviderType = 'google';
export type CalendarCredentialStatus = 'active' | 'revoked';

@Index(['botId', 'provider'], { unique: true, where: "status = 'active'" })
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
