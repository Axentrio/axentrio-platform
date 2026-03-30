import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { ChatSession } from './ChatSession';
import { ChannelConnection } from './ChannelConnection';

@Entity('conversation_bindings')
@Unique(['channelConnectionId', 'externalUserId', 'externalThreadId'])
@Index(['sessionId'])
@Index(['channelConnectionId', 'externalUserId'])
export class ConversationBinding {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  sessionId!: string;

  @Column('uuid')
  channelConnectionId!: string;

  @Column({ type: 'varchar', length: 255 })
  externalUserId!: string;

  @Column({ type: 'varchar', length: 255 })
  externalThreadId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  externalUserName!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  externalAvatarUrl!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  platformUserData!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => ChatSession)
  @JoinColumn({ name: 'sessionId' })
  session!: ChatSession;

  @ManyToOne(() => ChannelConnection)
  @JoinColumn({ name: 'channelConnectionId' })
  channelConnection!: ChannelConnection;
}
