/**
 * TypeORM Data Source Configuration
 * PostgreSQL connection with connection pooling
 */

import { DataSource } from 'typeorm';
import { config } from '../config/environment';
import { logger } from '../utils/logger';

// Import entities
import { Tenant } from './entities/Tenant';
import { User } from './entities/User';
import { Agent } from './entities/Agent';
import { ChatSession } from './entities/ChatSession';
import { Participant } from './entities/Participant';
import { Message } from './entities/Message';
import { FileUpload } from './entities/FileUpload';
import { HandoffRequest } from './entities/HandoffRequest';
import { WebhookDeliveryLog } from './entities/WebhookDeliveryLog';
import { PendingInvite } from './entities/PendingInvite';
import { AuditLog } from './entities/AuditLog';
import { KnowledgeBase } from './entities/KnowledgeBase';
import { KnowledgeDocument } from './entities/KnowledgeDocument';
import { KnowledgeChunk } from './entities/KnowledgeChunk';
import { CannedResponse } from './entities/CannedResponse';
import { ChannelConnection } from './entities/ChannelConnection';
import { ConversationBinding } from './entities/ConversationBinding';
import { WebhookEventLog } from './entities/WebhookEventLog';
import { MessageDelivery } from './entities/MessageDelivery';
import { BookingLog } from './entities/BookingLog';

// Create the DataSource instance
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: config.database.host,
  port: config.database.port,
  username: config.database.user,
  password: config.database.password,
  database: config.database.name,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : false,

  // Entity configuration
  entities: [
    Tenant,
    User,
    Agent,
    ChatSession,
    Participant,
    Message,
    FileUpload,
    HandoffRequest,
    WebhookDeliveryLog,
    PendingInvite,
    AuditLog,
    KnowledgeBase,
    KnowledgeDocument,
    KnowledgeChunk,
    CannedResponse,
    ChannelConnection,
    ConversationBinding,
    WebhookEventLog,
    MessageDelivery,
    BookingLog,
  ],

  // Migration configuration (disabled in test — tests use synchronize from entities)
  migrations: config.server.isTest ? [] : [__dirname + '/migrations/*.ts'],
  migrationsTableName: 'migrations',
  migrationsRun: false,

  // Connection pool settings
  extra: {
    max: config.database.poolSize,
    connectionTimeoutMillis: config.database.connectionTimeout,
    idleTimeoutMillis: 30000,
    options: '-c timezone=UTC',
  },

  // Logging
  logging: ['error'],
  logger: 'advanced-console',

  // Synchronization disabled — always use migrations instead
  synchronize: false,
});

// Initialize database connection
export const initializeDatabase = async (): Promise<DataSource> => {
  try {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
      logger.info('Database connection established successfully', {
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
      });
    }
    return AppDataSource;
  } catch (error) {
    logger.error('Failed to initialize database connection', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
};

// Close database connection
export const closeDatabase = async (): Promise<void> => {
  try {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
      logger.info('Database connection closed successfully');
    }
  } catch (error) {
    logger.error('Error closing database connection', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
};

// Health check function
export const checkDatabaseHealth = async (): Promise<boolean> => {
  try {
    if (!AppDataSource.isInitialized) {
      return false;
    }
    await AppDataSource.query('SELECT 1');
    return true;
  } catch (error) {
    logger.error('Database health check failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
};

// Get repository helper
export const getRepository = <T>(entity: new () => T) => {
  return AppDataSource.getRepository(entity);
};

// Transaction helper
export const runInTransaction = async <T>(
  callback: (manager: typeof AppDataSource.manager) => Promise<T>
): Promise<T> => {
  return AppDataSource.transaction(async (manager) => {
    return callback(manager);
  });
};

// Default export removed — TypeORM CLI requires exactly one DataSource export.
// Use the named export `AppDataSource` instead.
