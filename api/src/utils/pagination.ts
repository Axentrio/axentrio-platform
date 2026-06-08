import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export interface ParsedPaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export function parsePaginationParams(query: Record<string, unknown>): ParsedPaginationParams {
  const page = query.page ? Math.max(1, parseInt(String(query.page))) : undefined;
  const offset = query.offset ? Math.max(0, parseInt(String(query.offset))) : undefined;
  const limit = Math.min(Math.max(1, parseInt(String(query.limit)) || DEFAULT_LIMIT), MAX_LIMIT);

  const resolvedPage = offset !== undefined ? Math.floor(offset / limit) + 1 : (page || 1);

  return {
    page: resolvedPage,
    limit,
    sortBy: query.sortBy ? String(query.sortBy) : undefined,
    sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc',
  };
}

export async function applyPagination<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  params: ParsedPaginationParams
): Promise<PaginatedResult<T>> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || DEFAULT_LIMIT, MAX_LIMIT);

  // SQL-injection guard (#B): never interpolate a raw `sortBy` into ORDER BY.
  // Accept it only if it matches a real column of the queried entity, and emit
  // the vetted metadata property (never the raw string). `sortOrder` is already
  // normalized to 'asc'|'desc' by parsePaginationParams.
  const alias = queryBuilder.alias;
  const dir: 'ASC' | 'DESC' = params.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const columns = queryBuilder.expressionMap.mainAlias?.metadata?.columns ?? [];
  const vettedProp = params.sortBy
    ? columns.find((c) => c.propertyName === params.sortBy || c.databaseName === params.sortBy)?.propertyName
    : undefined;
  const hasExistingOrder = Object.keys(queryBuilder.expressionMap.orderBys ?? {}).length > 0;

  if (vettedProp) {
    // Valid, explicit user sort — replaces any default order.
    queryBuilder.orderBy(`${alias}.${vettedProp}`, dir);
  } else if (!hasExistingOrder) {
    // No (valid) sort and no caller-defined order: apply a safe default if the
    // entity has one. An INVALID `sortBy` never reaches ORDER BY and never
    // clobbers a caller's existing order.
    const fallback =
      columns.find((c) => c.propertyName === 'createdAt')?.propertyName ??
      columns.find((c) => c.propertyName === 'id')?.propertyName;
    if (fallback) queryBuilder.orderBy(`${alias}.${fallback}`, dir);
  }

  queryBuilder.skip((page - 1) * limit).take(limit);
  const [data, total] = await queryBuilder.getManyAndCount();
  const totalPages = Math.ceil(total / limit);

  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}
