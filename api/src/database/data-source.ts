/**
 * TypeORM Data Source Configuration
 * PostgreSQL connection with connection pooling
 */

import { DataSource } from 'typeorm';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import { RedactingQueryLogger } from './query-logger';

// Import entities
import { Tenant } from './entities/Tenant';
import { User } from './entities/User';
import { Agent } from './entities/Agent';
import { Bot } from './entities/Bot';
import { BotKnowledgeBase } from './entities/BotKnowledgeBase';
import { ChatSession } from './entities/ChatSession';
import { Participant } from './entities/Participant';
import { Message } from './entities/Message';
import { FileUpload } from './entities/FileUpload';
import { UploadSession } from './entities/UploadSession';
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
import { AgentTrace } from './entities/AgentTrace';
import { TenantBillingAccount } from './entities/TenantBillingAccount';
import { LlmUsageDaily } from './entities/LlmUsageDaily';
import { BillingEvent } from './entities/BillingEvent';
import { StripeWebhookEvent } from './entities/StripeWebhookEvent';
import { TenantTrialReservation } from './entities/TenantTrialReservation';
import { LegalInvoice } from './entities/LegalInvoice';
import { FaqSection } from './entities/FaqSection';
import { FaqItem } from './entities/FaqItem';
import { DemandSignal } from './entities/DemandSignal';
import { Lead } from './entities/Lead';
import { LeadConversation } from './entities/LeadConversation';
import { CustomerMemory } from './entities/CustomerMemory';
import { CustomerMemoryFact } from './entities/CustomerMemoryFact';
import { CustomerMemoryRun } from './entities/CustomerMemoryRun';
import { CopilotDoc } from './entities/CopilotDoc';
import { CopilotConversation } from './entities/CopilotConversation';
import { CopilotMessage } from './entities/CopilotMessage';
import { CopilotTrace } from './entities/CopilotTrace';
import { ServiceType } from './entities/ServiceType';
import { AvailabilityRule } from './entities/AvailabilityRule';
import { BookingSettings } from './entities/BookingSettings';
import { Booking } from './entities/Booking';
import { TravelUsage } from './entities/TravelUsage';
import { AddressBinding } from './entities/AddressBinding';
import { AddressOffer } from './entities/AddressOffer';
import { TenantModule } from './entities/TenantModule';
import { CalendarCredential } from './entities/CalendarCredential';
import { AvailabilityCall } from './entities/AvailabilityCall';
import { BookingOffer } from './entities/BookingOffer';
import { OfferSelection } from './entities/OfferSelection';
import { BookingReference } from './entities/BookingReference';
import { Notification } from './entities/Notification';
import { MobileDevice } from './entities/MobileDevice';
import { NotificationDelivery } from './entities/NotificationDelivery';
import { EmailDelivery } from './entities/EmailDelivery';
import { NotificationOutbox } from './entities/NotificationOutbox';
import { CanonicalTopic } from './entities/CanonicalTopic';
import { Judgment } from './entities/Judgment';
import { Gap } from './entities/Gap';
import { InsightsRefreshState } from './entities/InsightsRefreshState';
import { InsightExperiment } from './entities/InsightExperiment';
import { InsightDigest } from './entities/InsightDigest';
import { SentimentTheme } from './entities/SentimentTheme';
import { BotTemplate } from './entities/BotTemplate';
import { BotTemplateVersion } from './entities/BotTemplateVersion';
import { TenantBotTemplate } from './entities/TenantBotTemplate';
import { SpamScamLog } from './entities/SpamScamLog';
import { GuardrailOutputLog } from './entities/GuardrailOutputLog';
import { ConversationCommand } from './entities/ConversationCommand';
import { StorageConnection } from './entities/StorageConnection';
import { StorageImportJob } from './entities/StorageImportJob';

// Create the DataSource instance
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: config.database.host,
  port: config.database.port,
  username: config.database.user,
  password: config.database.password,
  database: config.database.name,
  ssl: config.database.ssl ? {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  } : false,

  // Entity configuration
  entities: [
    Tenant,
    User,
    Agent,
    Bot,
    BotKnowledgeBase,
    ChatSession,
    Participant,
    Message,
    FileUpload,
    UploadSession,
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
    AgentTrace,
    TenantBillingAccount,
    LlmUsageDaily,
    BillingEvent,
    StripeWebhookEvent,
    TenantTrialReservation,
    LegalInvoice,
    FaqSection,
    FaqItem,
    DemandSignal,
    Lead,
    LeadConversation,
    CustomerMemory,
    CustomerMemoryFact,
    CustomerMemoryRun,
    CopilotDoc,
    CopilotConversation,
    CopilotMessage,
    CopilotTrace,
    ServiceType,
    AvailabilityRule,
    BookingSettings,
    Booking,
    TravelUsage,
    AddressBinding,
    AddressOffer,
    TenantModule,
    CalendarCredential,
    BookingReference,
    AvailabilityCall,
    BookingOffer,
    OfferSelection,
    Notification,
    MobileDevice,
    NotificationDelivery,
    EmailDelivery,
    NotificationOutbox,
    CanonicalTopic,
    Judgment,
    Gap,
    InsightsRefreshState,
    BotTemplate,
    BotTemplateVersion,
    TenantBotTemplate,
    InsightExperiment,
    InsightDigest,
    SentimentTheme,
    SpamScamLog,
    GuardrailOutputLog,
    ConversationCommand,
    StorageConnection,
    StorageImportJob,
  ],

  // Migration configuration (disabled in test — tests use synchronize from entities)
  migrations: config.server.isTest ? [] : [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
  // Run migrations on boot, except in test or when building the schema from
  // entities via DB_SYNCHRONIZE (local dev — migrations-from-scratch aren't supported).
  migrationsRun: process.env.DB_SYNCHRONIZE !== 'true' && process.env.NODE_ENV !== 'test',

  // Connection pool settings
  extra: {
    max: config.database.poolSize,
    connectionTimeoutMillis: config.database.connectionTimeout,
    idleTimeoutMillis: 30000,
    options: '-c timezone=UTC',
  },

  // Logging
  logging: ['error'],
  // NOT `advanced-console`, which prints every bound parameter on a failed query — and every
  // value a customer typed is a bound parameter. See `RedactingQueryLogger`.
  logger: new RedactingQueryLogger(),

  // Off in prod (use migrations). Opt-in for local dev via DB_SYNCHRONIZE=true,
  // which builds the schema from entities (extensions must pre-exist).
  synchronize: process.env.DB_SYNCHRONIZE === 'true',
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
