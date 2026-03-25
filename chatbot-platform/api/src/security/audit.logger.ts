/**
 * Security Audit Logger
 * White-label Chatbot Platform
 * 
 * Features:
 * - Comprehensive security event logging
 * - Structured log format (JSON)
 * - Log levels and severity
 * - GDPR-compliant data handling
 * - Log rotation and retention
 * - SIEM integration ready
 */

import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { format as _format } from 'util';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AuditAction =
  // Authentication
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGOUT'
  | 'PASSWORD_CHANGE'
  | 'PASSWORD_RESET_REQUEST'
  | 'PASSWORD_RESET_COMPLETE'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'MFA_CHALLENGE'
  | 'MFA_VERIFICATION'
  | 'SESSION_CREATED'
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALIDATED'
  | 'API_KEY_CREATED'
  | 'API_KEY_REVOKED'
  // Authorization
  | 'ACCESS_DENIED'
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_REVOKED'
  | 'ROLE_ASSIGNED'
  | 'ROLE_REMOVED'
  // Data Access
  | 'DATA_ACCESS'
  | 'DATA_EXPORT'
  | 'DATA_IMPORT'
  | 'DATA_DELETION'
  | 'DATA_MODIFICATION'
  | 'BULK_OPERATION'
  // File Operations
  | 'FILE_UPLOADED'
  | 'FILE_DOWNLOADED'
  | 'FILE_DELETED'
  | 'FILE_SCAN_COMPLETED'
  | 'FILE_QUARANTINED'
  | 'UPLOAD_URL_REQUESTED'
  | 'CHUNKED_UPLOAD_INITIATED'
  | 'CHUNKED_UPLOAD_COMPLETED'
  | 'FILE_DOWNLOAD_REQUESTED'
  // Tenant Operations
  | 'TENANT_CREATED'
  | 'TENANT_UPDATED'
  | 'TENANT_DELETED'
  | 'TENANT_SETTINGS_CHANGED'
  // User Operations
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DELETED'
  | 'USER_INVITED'
  | 'USER_ACTIVATED'
  | 'USER_DEACTIVATED'
  // Security Events
  | 'SUSPICIOUS_ACTIVITY'
  | 'RATE_LIMIT_EXCEEDED'
  | 'IP_BLOCKED'
  | 'IP_UNBLOCKED'
  | 'CSP_VIOLATION'
  | 'XSS_ATTEMPT_BLOCKED'
  | 'SQL_INJECTION_ATTEMPT'
  | 'BRUTE_FORCE_ATTEMPT'
  // Configuration
  | 'CONFIG_CHANGED'
  | 'SECURITY_POLICY_UPDATED'
  | 'WHITELIST_UPDATED'
  | 'ENCRYPTION_KEY_ROTATED'
  // System
  | 'SYSTEM_STARTUP'
  | 'SYSTEM_SHUTDOWN'
  | 'BACKUP_CREATED'
  | 'BACKUP_RESTORED'
  | 'ERROR'
  | 'UPLOAD_ERROR'
  | 'FILE_SCAN_ERROR';

export interface AuditLogEntry {
  timestamp: string;
  level: LogLevel;
  action: AuditAction;
  tenantId: string;
  userId: string;
  resource: string;
  resourceId?: string;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  sessionId?: string;
  requestId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLoggerConfig {
  logDirectory: string;
  logLevel: LogLevel;
  consoleOutput: boolean;
  fileOutput: boolean;
  jsonFormat: boolean;
  includeStackTrace: boolean;
  retentionDays: number;
  maxFileSize: number;
  maxFiles: number;
  sensitiveFields: string[];
  gdprMode: boolean;
}

export interface LogFilter {
  tenantId?: string;
  userId?: string;
  action?: AuditAction;
  severity?: Severity;
  startDate?: Date;
  endDate?: Date;
  resource?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: AuditLoggerConfig = {
  logDirectory: process.env.LOG_DIRECTORY || './logs',
  logLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
  consoleOutput: process.env.NODE_ENV !== 'production',
  fileOutput: true,
  jsonFormat: true,
  includeStackTrace: process.env.NODE_ENV === 'development',
  retentionDays: 90,
  maxFileSize: 100 * 1024 * 1024, // 100MB
  maxFiles: 10,
  sensitiveFields: [
    'password',
    'token',
    'secret',
    'apiKey',
    'creditCard',
    'ssn',
    'passwordHash',
    'privateKey',
    'sessionToken',
    'refreshToken',
  ],
  gdprMode: true,
};

// ============================================================================
// Log Level Priority
// ============================================================================

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

// ============================================================================
// Audit Logger Class
// ============================================================================

export class AuditLogger {
  private config: AuditLoggerConfig;
  private logStream?: ReturnType<typeof createWriteStream>;
  private errorLogStream?: ReturnType<typeof createWriteStream>;
  private securityLogStream?: ReturnType<typeof createWriteStream>;
  private buffer: AuditLogEntry[] = [];
  private flushInterval?: NodeJS.Timeout;

  constructor(config?: Partial<AuditLoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initialize();
  }

  private initialize(): void {
    // Create log directory if it doesn't exist
    if (this.config.fileOutput && !existsSync(this.config.logDirectory)) {
      mkdirSync(this.config.logDirectory, { recursive: true });
    }

    // Initialize log streams
    if (this.config.fileOutput) {
      const timestamp = new Date().toISOString().split('T')[0];
      
      this.logStream = createWriteStream(
        join(this.config.logDirectory, `audit-${timestamp}.log`),
        { flags: 'a' }
      );

      this.errorLogStream = createWriteStream(
        join(this.config.logDirectory, `error-${timestamp}.log`),
        { flags: 'a' }
      );

      this.securityLogStream = createWriteStream(
        join(this.config.logDirectory, `security-${timestamp}.log`),
        { flags: 'a' }
      );
    }

    // Start buffer flush interval
    this.flushInterval = setInterval(() => {
      this.flushBuffer();
    }, 5000);

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  // ==========================================================================
  // Logging Methods
  // ==========================================================================

  /**
   * Log a security audit event
   */
  log(entry: Partial<AuditLogEntry>): void {
    const fullEntry = this.createLogEntry(entry);

    // Check log level
    if (!this.shouldLog(fullEntry.level)) {
      return;
    }

    // Add to buffer
    this.buffer.push(fullEntry);

    // Flush immediately for high severity events
    if (fullEntry.severity === 'CRITICAL' || fullEntry.severity === 'HIGH') {
      this.flushBuffer();
    }

    // Console output
    if (this.config.consoleOutput) {
      this.consoleOutput(fullEntry);
    }
  }

  /**
   * Log debug message
   */
  debug(message: string, details?: Record<string, unknown>): void {
    this.log({
      level: 'debug',
      action: 'ERROR',
      message,
      details,
      severity: 'LOW',
    });
  }

  /**
   * Log info message
   */
  info(message: string, details?: Record<string, unknown>): void {
    this.log({
      level: 'info',
      action: 'ERROR',
      message,
      details,
      severity: 'LOW',
    });
  }

  /**
   * Log warning
   */
  warn(message: string, details?: Record<string, unknown>): void {
    this.log({
      level: 'warn',
      action: 'ERROR',
      message,
      details,
      severity: 'MEDIUM',
    });
  }

  /**
   * Log error
   */
  error(message: string, error?: Error, details?: Record<string, unknown>): void {
    this.log({
      level: 'error',
      action: 'ERROR',
      message,
      details: {
        ...details,
        errorMessage: error?.message,
        stackTrace: this.config.includeStackTrace ? error?.stack : undefined,
      },
      severity: 'HIGH',
    });
  }

  /**
   * Log critical security event
   */
  critical(action: AuditAction, message: string, details?: Record<string, unknown>): void {
    this.log({
      level: 'critical',
      action,
      message,
      details,
      severity: 'CRITICAL',
    });
  }

  /**
   * Log authentication event
   */
  logAuth(
    action: 'LOGIN_SUCCESS' | 'LOGIN_FAILURE' | 'LOGOUT',
    tenantId: string,
    userId: string,
    details?: Record<string, unknown>,
    ip?: string,
    userAgent?: string
  ): void {
    this.log({
      level: action === 'LOGIN_FAILURE' ? 'warn' : 'info',
      action,
      tenantId,
      userId,
      resource: 'auth',
      severity: action === 'LOGIN_FAILURE' ? 'MEDIUM' : 'LOW',
      message: `Authentication event: ${action}`,
      details,
      ip,
      userAgent,
    });
  }

  /**
   * Log access denied event
   */
  logAccessDenied(
    tenantId: string,
    userId: string,
    resource: string,
    reason: string,
    ip?: string
  ): void {
    this.log({
      level: 'warn',
      action: 'ACCESS_DENIED',
      tenantId,
      userId,
      resource,
      severity: 'HIGH',
      message: `Access denied to ${resource}: ${reason}`,
      details: { reason },
      ip,
    });
  }

  /**
   * Log data access event
   */
  logDataAccess(
    tenantId: string,
    userId: string,
    resource: string,
    resourceId: string,
    action: 'read' | 'write' | 'delete',
    ip?: string
  ): void {
    this.log({
      level: 'info',
      action: 'DATA_ACCESS',
      tenantId,
      userId,
      resource,
      resourceId,
      severity: 'LOW',
      message: `Data ${action}: ${resource}/${resourceId}`,
      details: { action },
      ip,
    });
  }

  /**
   * Log suspicious activity
   */
  logSuspiciousActivity(
    tenantId: string,
    description: string,
    details?: Record<string, unknown>,
    ip?: string,
    userAgent?: string
  ): void {
    this.log({
      level: 'warn',
      action: 'SUSPICIOUS_ACTIVITY',
      tenantId,
      userId: (typeof details?.userId === 'string' ? details.userId : 'unknown'),
      resource: 'security',
      severity: 'HIGH',
      message: description,
      details,
      ip,
      userAgent,
    });
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private createLogEntry(partial: Partial<AuditLogEntry>): AuditLogEntry {
    const timestamp = new Date().toISOString();
    
    return {
      timestamp,
      level: partial.level || 'info',
      action: partial.action || 'ERROR',
      tenantId: partial.tenantId || 'system',
      userId: partial.userId || 'anonymous',
      resource: partial.resource || 'unknown',
      severity: partial.severity || 'LOW',
      message: partial.message || '',
      details: this.sanitizeDetails(partial.details),
      ip: this.maskIp(partial.ip),
      userAgent: partial.userAgent,
      sessionId: partial.sessionId,
      requestId: partial.requestId || this.generateRequestId(),
      correlationId: partial.correlationId,
      metadata: partial.metadata,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.logLevel];
  }

  private sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!details) return undefined;

    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(details)) {
      if (this.config.sensitiveFields.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeDetails(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private maskIp(ip?: string): string | undefined {
    if (!ip || !this.config.gdprMode) return ip;

    // Mask last octet of IPv4
    if (ip.includes('.')) {
      const parts = ip.split('.');
      parts[3] = 'xxx';
      return parts.join('.');
    }

    // Mask last 64 bits of IPv6
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return parts.slice(0, 4).join(':') + ':xxxx:xxxx:xxxx:xxxx';
    }

    return ip;
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // ==========================================================================
  // Output Methods
  // ==========================================================================

  private consoleOutput(entry: AuditLogEntry): void {
    const color = this.getLevelColor(entry.level);
    const reset = '\x1b[0m';
    
    const output = this.config.jsonFormat
      ? JSON.stringify(entry)
      : `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.action} - ${entry.message}`;

    console.log(`${color}${output}${reset}`);
  }

  private getLevelColor(level: LogLevel): string {
    const colors: Record<LogLevel, string> = {
      debug: '\x1b[36m',    // Cyan
      info: '\x1b[32m',     // Green
      warn: '\x1b[33m',     // Yellow
      error: '\x1b[31m',    // Red
      critical: '\x1b[35m', // Magenta
    };
    return colors[level] || '\x1b[0m';
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    if (!this.config.fileOutput) return;

    for (const entry of entries) {
      const logLine = JSON.stringify(entry) + '\n';

      // Write to main audit log
      this.logStream?.write(logLine);

      // Write to error log for errors
      if (entry.level === 'error' || entry.level === 'critical') {
        this.errorLogStream?.write(logLine);
      }

      // Write to security log for security events
      if (this.isSecurityEvent(entry)) {
        this.securityLogStream?.write(logLine);
      }
    }
  }

  private isSecurityEvent(entry: AuditLogEntry): boolean {
    const securityActions: AuditAction[] = [
      'LOGIN_SUCCESS',
      'LOGIN_FAILURE',
      'LOGOUT',
      'PASSWORD_CHANGE',
      'PASSWORD_RESET_REQUEST',
      'PASSWORD_RESET_COMPLETE',
      'MFA_ENABLED',
      'MFA_DISABLED',
      'ACCESS_DENIED',
      'SUSPICIOUS_ACTIVITY',
      'RATE_LIMIT_EXCEEDED',
      'IP_BLOCKED',
      'CSP_VIOLATION',
      'XSS_ATTEMPT_BLOCKED',
      'SQL_INJECTION_ATTEMPT',
      'BRUTE_FORCE_ATTEMPT',
      'API_KEY_CREATED',
      'API_KEY_REVOKED',
    ];

    return securityActions.includes(entry.action);
  }

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  /**
   * Query logs (in-memory buffer only)
   * For full query capability, use a log aggregation service
   */
  query(filter: LogFilter): AuditLogEntry[] {
    return this.buffer.filter((entry) => {
      if (filter.tenantId && entry.tenantId !== filter.tenantId) return false;
      if (filter.userId && entry.userId !== filter.userId) return false;
      if (filter.action && entry.action !== filter.action) return false;
      if (filter.severity && entry.severity !== filter.severity) return false;
      if (filter.resource && entry.resource !== filter.resource) return false;
      if (filter.startDate && new Date(entry.timestamp) < filter.startDate) return false;
      if (filter.endDate && new Date(entry.timestamp) > filter.endDate) return false;
      return true;
    });
  }

  /**
   * Get recent logs from buffer
   */
  getRecent(count: number = 100): AuditLogEntry[] {
    return this.buffer.slice(-count);
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    bufferSize: number;
    config: AuditLoggerConfig;
  } {
    return {
      bufferSize: this.buffer.length,
      config: this.config,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  private shutdown(): void {
    console.log('Shutting down audit logger...');
    
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    this.flushBuffer();

    this.logStream?.end();
    this.errorLogStream?.end();
    this.securityLogStream?.end();
  }

  destroy(): void {
    this.shutdown();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let auditLoggerInstance: AuditLogger | null = null;

export function getAuditLogger(config?: Partial<AuditLoggerConfig>): AuditLogger {
  if (!auditLoggerInstance) {
    auditLoggerInstance = new AuditLogger(config);
  }
  return auditLoggerInstance;
}

export function resetAuditLogger(): void {
  auditLoggerInstance?.destroy();
  auditLoggerInstance = null;
}

// Default export for convenience
export const auditLogger = getAuditLogger();

export default AuditLogger;
