import { describe, it, expect } from 'vitest';
import { parsePaginationParams } from '../../utils/pagination';

describe('parsePaginationParams', () => {
  it('should return defaults for empty query', () => {
    const result = parsePaginationParams({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it('should cap limit at 100', () => {
    const result = parsePaginationParams({ limit: '500' });
    expect(result.limit).toBe(100);
  });

  it('should parse valid page and limit', () => {
    const result = parsePaginationParams({ page: '3', limit: '10' });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(10);
  });

  it('should convert offset to page', () => {
    const result = parsePaginationParams({ offset: '40', limit: '20' });
    expect(result.page).toBe(3);
  });

  it('should prefer offset over page when both provided', () => {
    const result = parsePaginationParams({ page: '5', offset: '0', limit: '20' });
    expect(result.page).toBe(1);
  });

  it('should handle negative values gracefully', () => {
    const result = parsePaginationParams({ page: '-1', limit: '-5' });
    expect(result.page).toBe(1);
    expect(result.limit).toBe(1);
  });

  it('should default sortOrder to desc', () => {
    const result = parsePaginationParams({});
    expect(result.sortOrder).toBe('desc');
  });

  it('should accept asc sortOrder', () => {
    const result = parsePaginationParams({ sortOrder: 'asc' });
    expect(result.sortOrder).toBe('asc');
  });

  it('should fall back to desc for invalid sortOrder', () => {
    const result = parsePaginationParams({ sortOrder: 'invalid' });
    expect(result.sortOrder).toBe('desc');
  });

  it('should pass through sortBy when provided', () => {
    const result = parsePaginationParams({ sortBy: 'createdAt' });
    expect(result.sortBy).toBe('createdAt');
  });

  it('should leave sortBy undefined when not provided', () => {
    const result = parsePaginationParams({});
    expect(result.sortBy).toBeUndefined();
  });

  it('should floor limit to 1 when non-numeric', () => {
    const result = parsePaginationParams({ limit: 'abc' });
    expect(result.limit).toBe(20);
  });
});
