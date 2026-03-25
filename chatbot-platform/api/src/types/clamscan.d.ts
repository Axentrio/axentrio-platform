declare module 'clamscan' {
  export default class ClamScan {
    init(options?: any): Promise<ClamScan>;
    isInfected(filePath: string): Promise<{ isInfected: boolean; viruses: string[] }>;
    scanBuffer(buffer: Buffer): Promise<{ isInfected: boolean; viruses: string[] }>;
  }
}
