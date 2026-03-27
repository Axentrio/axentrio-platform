export interface Chunk {
  content: string;
  charCount: number;
  chunkIndex: number;
  metadata: Record<string, any>;
}

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''];

export function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number
): Chunk[] {
  const rawChunks = recursiveSplit(text, chunkSize, chunkOverlap, SEPARATORS);
  return rawChunks.map((content, index) => ({
    content,
    charCount: content.length,
    chunkIndex: index,
    metadata: {},
  }));
}

function recursiveSplit(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  separators: string[]
): string[] {
  if (text.length <= chunkSize) {
    return text.trim() ? [text.trim()] : [];
  }

  const separator = separators.find((sep) =>
    sep === '' ? true : text.includes(sep)
  );
  if (separator === undefined) return [text.trim()];

  const parts = separator === '' ? [...text] : text.split(separator);
  const chunks: string[] = [];
  let current = '';

  for (const part of parts) {
    const candidate = current ? current + separator + part : part;
    if (candidate.length > chunkSize && current) {
      chunks.push(current.trim());
      const overlapText = current.slice(-chunkOverlap);
      current = overlapText + separator + part;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  const result: string[] = [];
  const remainingSeparators = separators.slice(separators.indexOf(separator!) + 1);
  for (const chunk of chunks) {
    if (chunk.length > chunkSize && remainingSeparators.length > 0) {
      result.push(...recursiveSplit(chunk, chunkSize, chunkOverlap, remainingSeparators));
    } else {
      result.push(chunk);
    }
  }

  return result.filter((c) => c.trim().length > 0);
}
