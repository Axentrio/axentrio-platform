/**
 * Shared byte-capped stream reader for cloud-import downloads.
 * Caps memory per job at the provider level before any S3 write happens.
 */
export async function readCappedStream(
  stream: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += buf.length;
    if (n > maxBytes) throw new Error("File exceeds the size limit");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
