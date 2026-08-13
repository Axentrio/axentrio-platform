/** Keep this in one place: Vitest, global setup, and each worker must agree. */
function testDatabaseBaseName(baseUrl: string): string {
  const baseName = new URL(baseUrl).pathname.replace(/^\//, '') || 'chatbot_test';
  if (!/^[a-zA-Z0-9_]+$/.test(baseName)) {
    throw new Error('Unsafe test database name');
  }
  return baseName;
}

export function testTemplateDatabaseName(baseUrl: string): string {
  return `${testDatabaseBaseName(baseUrl)}_template`;
}

/** One disposable database per Vitest file process, never per recycled pool slot. */
export function testFileDatabaseName(baseUrl: string, workerId: number | string): string {
  const id = String(workerId);
  if (!/^\d+$/.test(id)) throw new Error('Unsafe test worker id');
  return `${testDatabaseBaseName(baseUrl)}_file_${id}`;
}

export function testFileDatabasePrefix(baseUrl: string): string {
  return `${testDatabaseBaseName(baseUrl)}_file_`;
}

/** Derive a file-process URL without mutating or replacing the base URL. */
export function testFileDatabaseUrl(baseUrl: string, workerId: number | string): string {
  const workerUrl = new URL(baseUrl);
  workerUrl.pathname = `/${testFileDatabaseName(baseUrl, workerId)}`;
  return workerUrl.toString();
}
