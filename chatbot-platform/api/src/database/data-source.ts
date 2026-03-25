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
  ],

  // Migration configuration
  migrations: [__dirname + '/migrations/*.ts'],
  migrationsTableName: 'migrations',
  migrationsRun: false, // Run migrations manually

  // Connection pool settings
  extra: {
    max: config.database.poolSize,
    connectionTimeoutMillis: config.database.connectionTimeout,
    idleTimeoutMillis: 30000,
  },

  // Logging
  logging: config.server.isDevelopment ? ['query', 'error'] : ['error'],
  logger: 'advanced-console',

  // Synchronization — controlled by DB_SYNC env var, defaults to dev-only
  synchronize: process.env.DB_SYNC === 'true' || (config.server.isDevelopment && !config.database.url),
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

export default AppDataSource;
