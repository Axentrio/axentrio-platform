declare module 'dompurify' {
  interface DOMPurifyConfig {
    ALLOWED_TAGS?: string[];
    ALLOWED_ATTR?: string[];
    FORBID_TAGS?: string[];
    FORBID_ATTR?: string[];
    ALLOW_DATA_ATTR?: boolean;
    ADD_TAGS?: string[];
    ADD_ATTR?: string[];
    USE_PROFILES?: { html?: boolean; svg?: boolean; mathMl?: boolean };
    RETURN_DOM?: boolean;
    RETURN_DOM_FRAGMENT?: boolean;
    RETURN_TRUSTED_TYPE?: boolean;
    WHOLE_DOCUMENT?: boolean;
    FORCE_BODY?: boolean;
    SANITIZE_DOM?: boolean;
    KEEP_CONTENT?: boolean;
    IN_PLACE?: boolean;
    PARSER_MEDIA_TYPE?: DOMParserSupportedType;
  }

  interface DOMPurifyInstance {
    sanitize: (html: string, config?: DOMPurifyConfig) => string;
    addHook: (hook: string, callback: (...args: [Node, Record<string, unknown>]) => void) => void;
    removeHook: (hook: string) => void;
  }

  const createDOMPurify: (window: Window) => DOMPurifyInstance;
  export default createDOMPurify;
}
