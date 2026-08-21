declare module "playwright" {
  export const chromium: {
    launch: (opts: { headless: boolean }) => Promise<{
      newPage: (opts: { userAgent: string }) => Promise<{
        route: (
          pattern: string,
          handler: (route: {
            request: () => { url: () => string };
            continue: () => Promise<void>;
            abort: () => Promise<void>;
          }) => Promise<void>,
        ) => Promise<void>;
        goto: (
          url: string,
          opts: { waitUntil: string; timeout: number },
        ) => Promise<unknown>;
        waitForTimeout: (ms: number) => Promise<void>;
        evaluate: (fn: () => Promise<void>) => Promise<void>;
        content: () => Promise<string>;
      }>;
      close: () => Promise<void>;
    }>;
  };
}
