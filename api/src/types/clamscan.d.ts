declare module 'clamscan' {
  interface ClamScanOptions {
    removeInfected?: boolean;
    quarantineInfected?: boolean | string;
    scanLog?: string | null;
    debugMode?: boolean;
    fileList?: string | null;
    scanRecursively?: boolean;
    clamscan?: {
      path?: string;
      db?: string;
      scanArchives?: boolean;
      active?: boolean;
    };
    clamdscan?: {
      socket?: string | boolean;
      host?: string;
      port?: number;
      timeout?: number;
      localFallback?: boolean;
      path?: string;
      configFile?: string;
      multiscan?: boolean;
      reloadDb?: boolean;
      active?: boolean;
    };
    preference?: 'clamscan' | 'clamdscan';
  }

  export default class ClamScan {
    init(options?: ClamScanOptions): Promise<ClamScan>;
    isInfected(filePath: string): Promise<{ isInfected: boolean; viruses: string[] }>;
    scanBuffer(buffer: Buffer): Promise<{ isInfected: boolean; viruses: string[] }>;
  }
}
