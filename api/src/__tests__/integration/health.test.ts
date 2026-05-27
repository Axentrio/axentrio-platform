import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

describe('GET /health', () => {
  it('should return 200 with status healthy', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'healthy');
  });
});
