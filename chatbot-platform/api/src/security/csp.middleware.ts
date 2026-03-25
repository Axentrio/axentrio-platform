/**
 * Content Security Policy Middleware
 * White-label Chatbot Platform
 * 
 * Features:
 * - Comprehensive CSP headers
 * - Nonce generation for inline scripts
 * - Report-only mode support
 * - Tenant-specific policy customization
 * - Violation reporting endpoint
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { auditLogger } from './audit.logger';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface CSPConfig {
  defaultSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  fontSrc: string[];
  connectSrc: string[];
  mediaSrc: string[];
  objectSrc: string[];
  frameSrc: string[];
  frameAncestors: string[];
  formAction: string[];
  baseUri: string[];
  manifestSrc: string[];
  workerSrc: string[];
  upgradeInsecureRequests: boolean;
  blockAllMixedContent: boolean;
  reportUri?: string;
  reportTo?: string;
  requireTrustedTypesFor?: string[];
  trustedTypes?: string[];
}

export interface CSPTenantConfig {
  tenantId: string;
  allowedDomains: string[];
  allowInlineScripts: boolean;
  allowInlineStyles: boolean;
  allowEval: boolean;
  allowDataUrls: boolean;
  allowBlobUrls: boolean;
  reportOnly: boolean;
  reportEndpoint?: string;
}

export interface CSPViolationReport {
  'csp-report': {
    'document-uri': string;
    referrer: string;
    'violated-directive': string;
    'effective-directive': string;
    'original-policy': string;
    'blocked-uri': string;
    'status-code': number;
    'script-sample'?: string;
    'source-file'?: string;
    'line-number'?: number;
    'column-number'?: number;
  };
}

// ============================================================================
// Default CSP Configuration
// ============================================================================

const DEFAULT_CSP_CONFIG: CSPConfig = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'", 'https:'],
  mediaSrc: ["'self'", 'blob:', 'https:'],
  objectSrc: ["'none'"],
  frameSrc: ["'self'"],
  frameAncestors: ["'self'"],
  formAction: ["'self'"],
  baseUri: ["'self'"],
  manifestSrc: ["'self'"],
  workerSrc: ["'self'", 'blob:'],
  upgradeInsecureRequests: true,
  blockAllMixedContent: true,
};

// ============================================================================
// Nonce Store
// ============================================================================

class NonceStore {
  private nonces: Map<string, { nonce: string; expiresAt: Date }> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean expired nonces every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  generate(sessionId: string): string {
    const nonce = randomBytes(16).toString('base64');
    this.nonces.set(sessionId, {
      nonce,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour expiry
    });
    return nonce;
  }

  validate(sessionId: string, nonce: string): boolean {
    const stored = this.nonces.get(sessionId);
    if (!stored) return false;
    if (stored.expiresAt < new Date()) {
      this.nonces.delete(sessionId);
      return false;
    }
    return stored.nonce === nonce;
  }

  get(sessionId: string): string | undefined {
    const stored = this.nonces.get(sessionId);
    if (stored && stored.expiresAt > new Date()) {
      return stored.nonce;
    }
    return undefined;
  }

  private cleanup(): void {
    const now = new Date();
    for (const [key, value] of this.nonces.entries()) {
      if (value.expiresAt < now) {
        this.nonces.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.nonces.clear();
  }
}

export const nonceStore = new NonceStore();

// ============================================================================
// CSP Builder
// ============================================================================

export class CSPBuilder {
  private config: CSPConfig;
  private nonce?: string;
  private tenantConfig?: CSPTenantConfig;

  constructor(config?: Partial<CSPConfig>) {
    this.config = { ...DEFAULT_CSP_CONFIG, ...config };
  }

  withNonce(nonce: string): this {
    this.nonce = nonce;
    return this;
  }

  withTenantConfig(config: CSPTenantConfig): this {
    this.tenantConfig = config;
    return this;
  }

  build(): string {
    const directives: string[] = [];
    const config = this.getEffectiveConfig();

    // Default source
    directives.push(`default-src ${config.defaultSrc.join(' ')}`);

    // Script source with nonce support
    const scriptSrc = [...config.scriptSrc];
    if (this.nonce) {
      scriptSrc.push(`'nonce-${this.nonce}'`);
    }
    if (this.tenantConfig?.allowEval) {
      scriptSrc.push("'unsafe-eval'");
    }
    if (this.tenantConfig?.allowInlineScripts) {
      scriptSrc.push("'unsafe-inline'");
    }
    directives.push(`script-src ${scriptSrc.join(' ')}`);

    // Style source
    const styleSrc = [...config.styleSrc];
    if (this.tenantConfig?.allowInlineStyles) {
      styleSrc.push("'unsafe-inline'");
    }
    directives.push(`style-src ${styleSrc.join(' ')}`);

    // Image source
    const imgSrc = [...config.imgSrc];
    if (this.tenantConfig?.allowDataUrls) {
      if (!imgSrc.includes('data:')) imgSrc.push('data:');
    }
    if (this.tenantConfig?.allowBlobUrls) {
      if (!imgSrc.includes('blob:')) imgSrc.push('blob:');
    }
    directives.push(`img-src ${imgSrc.join(' ')}`);

    // Font source
    directives.push(`font-src ${config.fontSrc.join(' ')}`);

    // Connect source
    const connectSrc = [...config.connectSrc];
    if (this.tenantConfig?.allowedDomains) {
      connectSrc.push(...this.tenantConfig.allowedDomains);
    }
    // Add WebSocket support
    connectSrc.push('wss:', 'ws:');
    directives.push(`connect-src ${[...new Set(connectSrc)].join(' ')}`);

    // Media source
    directives.push(`media-src ${config.mediaSrc.join(' ')}`);

    // Object source
    directives.push(`object-src ${config.objectSrc.join(' ')}`);

    // Frame source
    directives.push(`frame-src ${config.frameSrc.join(' ')}`);

    // Frame ancestors (for embedding)
    const frameAncestors = [...config.frameAncestors];
    if (this.tenantConfig?.allowedDomains) {
      frameAncestors.push(...this.tenantConfig.allowedDomains.map(d => {
        // Convert domain to frame-ancestor format
        return d.startsWith('https://') ? d : `https://${d}`;
      }));
    }
    directives.push(`frame-ancestors ${[...new Set(frameAncestors)].join(' ')}`);

    // Form action
    directives.push(`form-action ${config.formAction.join(' ')}`);

    // Base URI
    directives.push(`base-uri ${config.baseUri.join(' ')}`);

    // Manifest source
    directives.push(`manifest-src ${config.manifestSrc.join(' ')}`);

    // Worker source
    directives.push(`worker-src ${config.workerSrc.join(' ')}`);

    // Upgrade insecure requests
    if (config.upgradeInsecureRequests) {
      directives.push('upgrade-insecure-requests');
    }

    // Block all mixed content
    if (config.blockAllMixedContent) {
      directives.push('block-all-mixed-content');
    }

    // Report URI
    if (config.reportUri) {
      directives.push(`report-uri ${config.reportUri}`);
    }

    // Report To
    if (config.reportTo) {
      directives.push(`report-to ${config.reportTo}`);
    }

    // Trusted Types
    if (config.requireTrustedTypesFor && config.requireTrustedTypesFor.length > 0) {
      directives.push(`require-trusted-types-for ${config.requireTrustedTypesFor.join(' ')}`);
    }

    if (config.trustedTypes && config.trustedTypes.length > 0) {
      directives.push(`trusted-types ${config.trustedTypes.join(' ')}`);
    }

    return directives.join('; ');
  }

  private getEffectiveConfig(): CSPConfig {
    return this.config;
  }
}

// ============================================================================
// CSP Middleware Factory
// ============================================================================

export interface CSPMiddlewareOptions {
  reportOnly?: boolean;
  reportUri?: string;
  customConfig?: Partial<CSPConfig>;
  useNonce?: boolean;
  allowInlineStyles?: boolean;
  allowInlineScripts?: boolean;
}

export function createCSPMiddleware(options: CSPMiddlewareOptions = {}) {
  const builder = new CSPBuilder(options.customConfig);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Generate nonce if requested
    let nonce: string | undefined;
    if (options.useNonce) {
      const sessionId = req.session?.id || req.ip || 'anonymous';
      nonce = nonceStore.generate(sessionId);
      // Make nonce available to templates
      res.locals.cspNonce = nonce;
    }

    if (nonce) {
      builder.withNonce(nonce);
    }

    // Get tenant-specific config if available
    const tenantConfig = req.tenantConfig as CSPTenantConfig | undefined;
    if (tenantConfig) {
      builder.withTenantConfig(tenantConfig);
    }

    // Build CSP header
    const cspHeader = builder.build();

    // Set appropriate header
    const headerName = options.reportOnly || tenantConfig?.reportOnly
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';

    res.setHeader(headerName, cspHeader);

    // Also set Report-To header for modern browsers
    if (options.reportUri || tenantConfig?.reportEndpoint) {
      const reportEndpoint = tenantConfig?.reportEndpoint || options.reportUri;
      res.setHeader(
        'Report-To',
        JSON.stringify({
          group: 'csp-endpoint',
          max_age: 10886400,
          endpoints: [{ url: reportEndpoint }],
        })
      );
    }

    next();
  };
}

// ============================================================================
// Pre-configured Middleware Instances
// ============================================================================

/**
 * Standard CSP middleware for API responses
 */
export const cspMiddleware = createCSPMiddleware({
  customConfig: {
    ...DEFAULT_CSP_CONFIG,
    connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
  },
});

/**
 * Strict CSP middleware for admin panels
 */
export const strictCspMiddleware = createCSPMiddleware({
  customConfig: {
    ...DEFAULT_CSP_CONFIG,
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
  },
  useNonce: true,
});

/**
 * Widget CSP middleware for embeddable chat widget
 *
 * Security trade-off: 'unsafe-inline' is used for style-src because the widget
 * injects dynamic inline styles for theming and positioning that vary per tenant.
 * Nonces are not practical here since the widget HTML is served as a static embed
 * snippet. script-src uses nonces instead of 'unsafe-inline' for stronger protection.
 *
 * 'unsafe-inline' is intentionally NOT allowed for script-src.
 */
export const widgetCspMiddleware = createCSPMiddleware({
  customConfig: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ['data:', 'blob:', 'https:'],
    fontSrc: ["'none'"],
    connectSrc: ['https:', 'wss:'],
    mediaSrc: ['blob:', 'https:'],
    objectSrc: ["'none'"],
    frameSrc: ["'none'"],
    frameAncestors: ['*'], // Allow embedding anywhere
    formAction: ["'none'"],
    baseUri: ["'none'"],
    manifestSrc: ["'none'"],
    workerSrc: ['blob:'],
  },
  useNonce: true,
  allowInlineStyles: true,
});

/**
 * Report-only CSP middleware for testing
 */
export const reportOnlyCspMiddleware = createCSPMiddleware({
  reportOnly: true,
  reportUri: '/api/v1/security/csp-report',
  customConfig: DEFAULT_CSP_CONFIG,
});

// ============================================================================
// CSP Report Handler
// ============================================================================

export function handleCSPReport(req: Request, res: Response): void {
  const report: CSPViolationReport = req.body;

  if (!report || !report['csp-report']) {
    res.status(400).json({ error: 'Invalid CSP report' });
    return;
  }

  const cspReport = report['csp-report'];

  // Log the violation
  auditLogger.log({
    action: 'CSP_VIOLATION',
    tenantId: req.tenantId || 'unknown',
    userId: req.userId || 'anonymous',
    resource: 'csp',
    severity: 'MEDIUM',
    details: {
      documentUri: cspReport['document-uri'],
      violatedDirective: cspReport['violated-directive'],
      effectiveDirective: cspReport['effective-directive'],
      blockedUri: cspReport['blocked-uri'],
      sourceFile: cspReport['source-file'],
      lineNumber: cspReport['line-number'],
      scriptSample: cspReport['script-sample'],
    },
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Don't expose internal details in response
  res.status(204).send();
}

// ============================================================================
// Additional Security Headers Middleware
// ============================================================================

export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS Protection (legacy but still useful)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'camera=(self)',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=(self)',
      'payment=()',
      'usb=()',
    ].join(', ')
  );

  // Strict Transport Security (HSTS)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }

  // Cross-Origin policies
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  next();
}

// ============================================================================
// Tenant CSP Configuration Store
// ============================================================================

class TenantCSPStore {
  private configs: Map<string, CSPTenantConfig> = new Map();

  set(config: CSPTenantConfig): void {
    this.configs.set(config.tenantId, config);
  }

  get(tenantId: string): CSPTenantConfig | undefined {
    return this.configs.get(tenantId);
  }

  delete(tenantId: string): boolean {
    return this.configs.delete(tenantId);
  }

  has(tenantId: string): boolean {
    return this.configs.has(tenantId);
  }
}

export const tenantCSPStore = new TenantCSPStore();

// ============================================================================
// Express Declaration Merging
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      tenantConfig?: CSPTenantConfig;
    }
    interface Response {
      locals: {
        cspNonce?: string;
        [key: string]: any;
      };
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

export default {
  createCSPMiddleware,
  cspMiddleware,
  strictCspMiddleware,
  widgetCspMiddleware,
  reportOnlyCspMiddleware,
  securityHeadersMiddleware,
  handleCSPReport,
  CSPBuilder,
  nonceStore,
  tenantCSPStore,
};
