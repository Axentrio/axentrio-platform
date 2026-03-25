declare module 'dompurify' {
  const createDOMPurify: (window: any) => {
    sanitize: (html: string, config?: any) => string;
    addHook: (hook: string, callback: (...args: any[]) => any) => void;
    removeHook: (hook: string) => void;
  };
  export default createDOMPurify;
}
