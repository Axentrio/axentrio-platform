/**
 * XSS Protection Module
 * White-label Chatbot Platform
 * 
 * Features:
 * - Input sanitization with DOMPurify
 * - Output encoding
 * - Context-aware escaping
 * - HTML template sanitization
 * - JSON sanitization
 */

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { escape } from 'lodash';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface SanitizationConfig {
  allowedTags: string[];
  allowedAttributes: Record<string, string[]>;
  selfClosingTags: string[];
  allowedSchemes: string[];
  allowComments: boolean;
  allowDataAttributes: boolean;
  stripUnknownTags: boolean;
  stripUnknownAttributes: boolean;
}

export interface XSSProtectionOptions {
  mode: 'strict' | 'moderate' | 'permissive';
  allowHtml: boolean;
  allowMarkdown: boolean;
  maxLength: number;
  stripScripts: boolean;
  encodeOutput: boolean;
}

export interface SanitizationResult {
  clean: string;
  originalLength: number;
  cleanLength: number;
  removedTags: string[];
  removedAttributes: string[];
  isTruncated: boolean;
}

export type EscapeContext = 'html' | 'htmlAttribute' | 'css' | 'js' | 'url' | 'htmlComment';

// ============================================================================
// Default Configurations
// ============================================================================

const STRICT_SANITIZATION_CONFIG: SanitizationConfig = {
  allowedTags: [],
  allowedAttributes: {},
  selfClosingTags: [],
  allowedSchemes: ['https', 'http'],
  allowComments: false,
  allowDataAttributes: false,
  stripUnknownTags: true,
  stripUnknownAttributes: true,
};

const MODERATE_SANITIZATION_CONFIG: SanitizationConfig = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'strike', 'del',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'code', 'pre',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'div', 'span',
  ],
  allowedAttributes: {
    '*': ['class', 'id'],
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height', 'loading'],
    'table': ['border', 'cellpadding', 'cellspacing'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan'],
  },
  selfClosingTags: ['br', 'img', 'hr'],
  allowedSchemes: ['https', 'http', 'mailto', 'tel'],
  allowComments: false,
  allowDataAttributes: false,
  stripUnknownTags: true,
  stripUnknownAttributes: true,
};

const PERMISSIVE_SANITIZATION_CONFIG: SanitizationConfig = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'strike', 'del', 's',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'code', 'pre', 'kbd', 'samp',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
    'div', 'span', 'section', 'article', 'aside', 'header', 'footer',
    'hr', 'sub', 'sup', 'small', 'mark', 'ins',
    'details', 'summary',
    'iframe', // Only from trusted sources
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'dir', 'lang', 'title'],
    'a': ['href', 'title', 'target', 'rel', 'download'],
    'img': ['src', 'alt', 'title', 'width', 'height', 'loading', 'srcset', 'sizes'],
    'iframe': ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen'],
    'table': ['border', 'cellpadding', 'cellspacing', 'width'],
    'td': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
    'th': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
    'div': ['align'],
    'p': ['align'],
    'blockquote': ['cite'],
    'q': ['cite'],
    'code': ['class'],
    'pre': ['class'],
  },
  selfClosingTags: ['br', 'img', 'hr', 'input', 'area', 'base', 'col', 'embed', 'link', 'meta', 'param', 'source', 'track', 'wbr'],
  allowedSchemes: ['https', 'http', 'mailto', 'tel', 'ftp', 'sftp'],
  allowComments: false,
  allowDataAttributes: true,
  stripUnknownTags: true,
  stripUnknownAttributes: true,
};

// ============================================================================
// DOMPurify Setup
// ============================================================================

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window as any);

// ============================================================================
// XSS Protection Service
// ============================================================================

export class XSSProtectionService {
  private config: SanitizationConfig;
  private options: XSSProtectionOptions;

  constructor(
    mode: XSSProtectionOptions['mode'] = 'moderate',
    options: Partial<XSSProtectionOptions> = {}
  ) {
    this.options = {
      mode,
      allowHtml: mode !== 'strict',
      allowMarkdown: true,
      maxLength: 10000,
      stripScripts: true,
      encodeOutput: false,
      ...options,
    };

    switch (mode) {
      case 'strict':
        this.config = STRICT_SANITIZATION_CONFIG;
        break;
      case 'permissive':
        this.config = PERMISSIVE_SANITIZATION_CONFIG;
        break;
      case 'moderate':
      default:
        this.config = MODERATE_SANITIZATION_CONFIG;
        break;
    }
  }

  // ==========================================================================
  // Main Sanitization Methods
  // ==========================================================================

  /**
   * Sanitize HTML content
   */
  sanitizeHtml(input: string): SanitizationResult {
    if (!input) {
      return {
        clean: '',
        originalLength: 0,
        cleanLength: 0,
        removedTags: [],
        removedAttributes: [],
        isTruncated: false,
      };
    }

    const originalLength = input.length;
    let removedTags: string[] = [];
    let removedAttributes: string[] = [];

    // Track removed elements
    const beforeTags = new Set<string>();
    const afterTags = new Set<string>();

    // Truncate if too long
    let truncated = input;
    let isTruncated = false;
    if (originalLength > this.options.maxLength) {
      truncated = input.substring(0, this.options.maxLength);
      isTruncated = true;
    }

    // Parse to find tags before sanitization
    const tagRegex = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
    let match;
    while ((match = tagRegex.exec(truncated)) !== null) {
      beforeTags.add(match[1].toLowerCase());
    }

    // Configure DOMPurify
    const purifyConfig: any = {
      ALLOWED_TAGS: this.config.allowedTags,
      ALLOWED_ATTR: Object.entries(this.config.allowedAttributes).flatMap(
        ([tag, attrs]) => attrs.map((attr) => (tag === '*' ? attr : `${tag}.${attr}`))
      ),
      ALLOW_DATA_ATTR: this.config.allowDataAttributes,
      ALLOW_COMMENTS: this.config.allowComments,
      KEEP_CONTENT: true,
      SANITIZE_DOM: true,
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
      RETURN_TRUSTED_TYPE: false,
    };

    // Add hook to track removed elements
    DOMPurify.addHook('uponSanitizeElement', (_node: any, data: any) => {
      if (data.tagName) {
        removedTags.push(data.tagName);
      }
    });

    DOMPurify.addHook('uponSanitizeAttribute', (_node: any, data: any) => {
      if (data.attrName) {
        removedAttributes.push(data.attrName);
      }
    });

    // Sanitize
    let clean = DOMPurify.sanitize(truncated, purifyConfig);

    // Remove hooks
    DOMPurify.removeHook('uponSanitizeElement');
    DOMPurify.removeHook('uponSanitizeAttribute');

    // Find tags after sanitization
    const afterTagRegex = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
    while ((match = afterTagRegex.exec(clean)) !== null) {
      afterTags.add(match[1].toLowerCase());
    }

    // Calculate removed tags
    removedTags = Array.from(beforeTags).filter((tag) => !afterTags.has(tag));

    // Remove duplicates
    removedTags = [...new Set(removedTags)];
    removedAttributes = [...new Set(removedAttributes)];

    return {
      clean,
      originalLength,
      cleanLength: clean.length,
      removedTags,
      removedAttributes,
      isTruncated,
    };
  }

  /**
   * Sanitize plain text (no HTML allowed)
   */
  sanitizeText(input: string): string {
    if (!input) return '';

    // Truncate if too long
    if (input.length > this.options.maxLength) {
      input = input.substring(0, this.options.maxLength);
    }

    // Escape HTML entities
    return escape(input);
  }

  /**
   * Sanitize for use in HTML attribute
   */
  sanitizeAttribute(input: string): string {
    if (!input) return '';

    // Escape for HTML attribute context
    return input
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\//g, '&#x2F;')
      .replace(/\\/g, '&#x5C;')
      .replace(/`/g, '&#96;');
  }

  /**
   * Sanitize for use in JavaScript context
   */
  sanitizeForJs(input: string): string {
    if (!input) return '';

    // JSON stringify handles most escaping needs
    return JSON.stringify(input).slice(1, -1);
  }

  /**
   * Sanitize for use in CSS context
   */
  sanitizeForCss(input: string): string {
    if (!input) return '';

    // Remove dangerous CSS
    return input
      .replace(/[<>'"]/g, '')
      .replace(/expression\s*\(/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/behavior\s*:/gi, '')
      .replace(/@import/gi, '');
  }

  /**
   * Sanitize for use in URL context
   */
  sanitizeUrl(input: string): string {
    if (!input) return '';

    // Allow only safe URL schemes
    const allowedSchemes = this.config.allowedSchemes;
    const urlRegex = new RegExp(`^(${allowedSchemes.join('|')}):`, 'i');

    if (!urlRegex.test(input) && !input.startsWith('/') && !input.startsWith('#')) {
      // If no scheme and not a relative URL, assume https
      if (!input.includes(':')) {
        return `https://${input}`;
      }
      // Block dangerous schemes
      return '#';
    }

    return input;
  }

  /**
   * Sanitize JSON input
   */
  sanitizeJson<T = any>(input: T): T {
    if (input === null || input === undefined) {
      return input;
    }

    if (typeof input === 'string') {
      return this.sanitizeText(input) as unknown as T;
    }

    if (typeof input === 'number' || typeof input === 'boolean') {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((item) => this.sanitizeJson(item)) as unknown as T;
    }

    if (typeof input === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(input)) {
        // Sanitize keys too
        const sanitizedKey = this.sanitizeText(key).replace(/[^a-zA-Z0-9_]/g, '_');
        sanitized[sanitizedKey] = this.sanitizeJson(value);
      }
      return sanitized;
    }

    return input;
  }

  // ==========================================================================
  // Context-Aware Escaping
  // ==========================================================================

  /**
   * Escape input for specific context
   */
  escapeForContext(input: string, context: EscapeContext): string {
    switch (context) {
      case 'html':
        return this.escapeHtml(input);
      case 'htmlAttribute':
        return this.sanitizeAttribute(input);
      case 'css':
        return this.sanitizeForCss(input);
      case 'js':
        return this.sanitizeForJs(input);
      case 'url':
        return encodeURIComponent(input);
      case 'htmlComment':
        return this.escapeHtmlComment(input);
      default:
        return this.escapeHtml(input);
    }
  }

  /**
   * Escape HTML entities
   */
  escapeHtml(input: string): string {
    if (!input) return '';

    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };

    return input.replace(/[&<>"'\/]/g, (char) => htmlEscapes[char] || char);
  }

  /**
   * Escape HTML comments
   */
  escapeHtmlComment(input: string): string {
    if (!input) return '';

    return input
      .replace(/-->/g, '--&gt;')
      .replace(/<!--/g, '&lt;!--')
      .replace(/<!/g, '&lt;!');
  }

  // ==========================================================================
  // Markdown Sanitization
  // ==========================================================================

  /**
   * Sanitize Markdown content
   */
  sanitizeMarkdown(input: string): string {
    if (!input) return '';

    // Remove HTML tags first
    const noHtml = input.replace(/<[^>]*>/g, '');

    // Sanitize the text content
    const sanitized = this.sanitizeText(noHtml);

    // Re-enable safe Markdown syntax
    return sanitized
      // Headers
      .replace(/&gt;#/g, '#')
      // Bold/Italic
      .replace(/&gt;\*\*/g, '**')
      .replace(/&gt;\*/g, '*')
      // Code
      .replace(/&gt;`/g, '`')
      // Links
      .replace(/&gt;\[/g, '[')
      .replace(/&gt;\]/g, ']')
      .replace(/&gt;\(/g, '(')
      .replace(/&gt;\)/g, ')')
      // Lists
      .replace(/&gt;- /g, '- ')
      .replace(/&gt;\d+\./g, (match) => match.replace('&gt;', ''))
      // Blockquotes
      .replace(/&gt;&gt;/g, '>');
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Check if input contains HTML
   */
  containsHtml(input: string): boolean {
    return /<[^>]+>/g.test(input);
  }

  /**
   * Check if input contains script tags
   */
  containsScript(input: string): boolean {
    return /<script[^>]*>/gi.test(input);
  }

  /**
   * Check if input contains event handlers
   */
  containsEventHandlers(input: string): boolean {
    return /\s(on\w+)\s*=/gi.test(input);
  }

  /**
   * Strip all HTML tags
   */
  stripHtml(input: string): string {
    if (!input) return '';
    return input.replace(/<[^>]*>/g, '');
  }

  /**
   * Truncate text to maximum length
   */
  truncate(input: string, maxLength: number, suffix: string = '...'): string {
    if (!input || input.length <= maxLength) return input;
    return input.substring(0, maxLength - suffix.length) + suffix;
  }

  /**
   * Validate and sanitize email
   */
  sanitizeEmail(input: string): string | null {
    if (!input) return null;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const sanitized = input.toLowerCase().trim();

    if (!emailRegex.test(sanitized)) {
      return null;
    }

    return sanitized;
  }

  /**
   * Sanitize phone number
   */
  sanitizePhone(input: string): string | null {
    if (!input) return null;

    // Remove all non-numeric characters except +
    const sanitized = input.replace(/[^\d+]/g, '');

    // Basic validation
    if (sanitized.length < 8 || sanitized.length > 20) {
      return null;
    }

    return sanitized;
  }
}

// ============================================================================
// Express Middleware
// ============================================================================

import { Request, Response, NextFunction } from 'express';

export interface XSSMiddlewareOptions {
  mode?: XSSProtectionOptions['mode'];
  sanitizeBody?: boolean;
  sanitizeQuery?: boolean;
  sanitizeParams?: boolean;
  maxLength?: number;
  fieldsToExclude?: string[];
}

/**
 * Create XSS protection middleware for Express
 */
export function createXSSMiddleware(options: XSSMiddlewareOptions = {}) {
  const {
    mode = 'moderate',
    sanitizeBody = true,
    sanitizeQuery = true,
    sanitizeParams = false,
    maxLength = 10000,
    fieldsToExclude = [],
  } = options;

  const xssService = new XSSProtectionService(mode, { maxLength });

  return (req: Request, res: Response, next: NextFunction): void => {
    // Attach service to request for use in routes
    req.xssProtection = xssService;

    // Sanitize request body
    if (sanitizeBody && req.body) {
      req.body = sanitizeObject(req.body, xssService, fieldsToExclude);
    }

    // Sanitize query parameters
    if (sanitizeQuery && req.query) {
      req.query = sanitizeObject(req.query, xssService, fieldsToExclude);
    }

    // Sanitize URL parameters
    if (sanitizeParams && req.params) {
      req.params = sanitizeObject(req.params, xssService, fieldsToExclude);
    }

    // Add sanitization helper to response
    res.sanitize = (input: string, context?: EscapeContext) => {
      if (context) {
        return xssService.escapeForContext(input, context);
      }
      return xssService.sanitizeHtml(input).clean;
    };

    next();
  };
}

/**
 * Recursively sanitize object values
 */
function sanitizeObject(
  obj: any,
  xssService: XSSProtectionService,
  excludeFields: string[]
): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return xssService.sanitizeHtml(obj).clean;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, xssService, excludeFields));
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (excludeFields.includes(key)) {
        sanitized[key] = value;
      } else {
        sanitized[key] = sanitizeObject(value, xssService, excludeFields);
      }
    }
    return sanitized;
  }

  return obj;
}

// ============================================================================
// Pre-configured Middleware Instances
// ============================================================================

export const xssMiddleware = createXSSMiddleware({
  mode: 'moderate',
  sanitizeBody: true,
  sanitizeQuery: true,
});

export const strictXssMiddleware = createXSSMiddleware({
  mode: 'strict',
  sanitizeBody: true,
  sanitizeQuery: true,
});

export const apiXssMiddleware = createXSSMiddleware({
  mode: 'strict',
  sanitizeBody: true,
  sanitizeQuery: true,
  fieldsToExclude: ['password', 'token', 'secret', 'apiKey'],
});

// ============================================================================
// Express Declaration Merging
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      xssProtection?: XSSProtectionService;
    }
    interface Response {
      sanitize: (input: string, context?: EscapeContext) => string;
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let xssServiceInstance: XSSProtectionService | null = null;

export function getXSSProtectionService(
  mode: XSSProtectionOptions['mode'] = 'moderate',
  options?: Partial<XSSProtectionOptions>
): XSSProtectionService {
  if (!xssServiceInstance) {
    xssServiceInstance = new XSSProtectionService(mode, options);
  }
  return xssServiceInstance;
}

export function resetXSSProtectionService(): void {
  xssServiceInstance = null;
}

export default XSSProtectionService;
