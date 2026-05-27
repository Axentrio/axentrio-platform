declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    window: DOMWindow;
  }

  interface ConstructorOptions {
    url?: string;
    referrer?: string;
    contentType?: string;
    includeNodeLocations?: boolean;
    runScripts?: 'dangerously' | 'outside-only';
    pretendToBeVisual?: boolean;
  }

  interface DOMWindow extends Window {
    [key: string]: unknown;
  }
}
