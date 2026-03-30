/**
 * Participant Entity
 * Represents a participant in a chat session (user, agent, bot, or system)
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ChatSession } from './ChatSession';
import { Message } from './Message';

export type ParticipantType = 'user' | 'agent' | 'bot' | 'system';

@Entity('participants')
@Index(['sessionId', 'type'])
export class Participant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({
    type: 'enum',
    enum: ['user', 'agent', 'bot', 'system'],
  })
  type!: ParticipantType;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId?: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'avatar_url' })
  avatarUrl?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'email' })
  email?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: {
    ipAddress?: string;
    userAgent?: string;
    location?: {
      country?: string;
      city?: string;
      timezone?: string;
    };
    browser?: {
      name?: string;
      version?: string;
    };
    os?: {
      name?: string;
      version?: string;
    };
    device?: {
      type?: string;
      model?: string;
    };
    customData?: Record<string, unknown>;
  };

  @Column({ type: 'boolean', default: false, name: 'is_anonymous' })
  isAnonymous!: boolean;

  @Column({ type: 'timestamptz', name: 'joined_at' })
  joinedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'left_at' })
  leftAt?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_seen_at' })
  lastSeenAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  // Relationships
  @ManyToOne(() => ChatSession, (session) => session.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session!: ChatSession;

  @OneToMany(() => Message, (message) => message.participant)
  messages!: Message[];

  // Helper methods
  isActive(): boolean {
    return !this.leftAt && !this.isDeleted;
  }

  softDelete(): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.email = undefined;
    if (this.metadata) {
      const cleaned = { ...this.metadata };
      delete cleaned.ipAddress;
      delete cleaned.userAgent;
      delete cleaned.browser;
      delete cleaned.os;
      delete cleaned.device;
      delete cleaned.location;
      this.metadata = cleaned;
    }
  }

  leave(): void {
    this.leftAt = new Date();
  }

  updateLastSeen(): void {
    this.lastSeenAt = new Date();
  }

  isAgent(): boolean {
    return this.type === 'agent';
  }

  isBot(): boolean {
    return this.type === 'bot';
  }

  isUser(): boolean {
    return this.type === 'user';
  }

  getDisplayName(): string {
    if (this.isAnonymous) {
      return 'Anonymous';
    }
    return this.name || 'Unknown';
  }
}
