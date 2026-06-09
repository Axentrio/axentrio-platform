// Standard API response envelope + shared primitives.
// Dates cross the wire as ISO strings, so all timestamp fields are `string`.

export type OperatorRole = 'super_admin' | 'admin' | 'supervisor' | 'agent';

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiMeta {
  pagination?: Pagination;
  timestamp?: string;
  requestId?: string;
  path?: string;
  // Notifications list carries an unread counter in meta.
  unreadCount?: number;
  hasMore?: boolean;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;
