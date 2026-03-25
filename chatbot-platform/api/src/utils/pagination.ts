import { SelectQueryBuilder } from 'typeorm';

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

export async function applyPagination<T>(
  queryBuilder: SelectQueryBuilder<T>,
  params: ParsedPaginationParams
): Promise<PaginatedResult<T>> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || DEFAULT_LIMIT, MAX_LIMIT);

  if (params.sortBy) {
    const alias = queryBuilder.alias;
    queryBuilder.orderBy(`${alias}.${params.sortBy}`, params.sortOrder === 'asc' ? 'ASC' : 'DESC');
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
