import { describe, expect, it, vi } from 'vitest';

describe('sessionApi', () => {
  it('prefers proxy auth API bases in dev before direct auth API fallbacks', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            user: {
              email: 'admin',
              name: 'Master Admin',
              role: 'admin',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastLoginAt: null,
            },
          }),
        })
    );

    const api = await import('@/lib/sessionApi');
    const session = await api.signInWithSession({ email: 'admin', password: 'secret' });

    expect(session.user.email).toBe('admin');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/auth-api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://viewer.example.com/auth-api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    );

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the configured proxy base before direct auth API fallbacks', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_AUTH_API', '/auth-api');
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ error: 'Not found' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            user: {
              email: 'admin',
              name: 'Master Admin',
              role: 'admin',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastLoginAt: null,
            },
          }),
        })
    );

    const api = await import('@/lib/sessionApi');
    const session = await api.signInWithSession({ email: 'admin', password: 'secret' });

    expect(session.user.email).toBe('admin');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/auth-api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://viewer.example.com/auth-api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    );

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns a clearer error when every auth API candidate is unreachable', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubGlobal('window', {
      location: {
        origin: 'https://viewer.example.com',
        protocol: 'https:',
        hostname: 'viewer.example.com',
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const api = await import('@/lib/sessionApi');

    await expect(api.signInWithSession({ email: 'admin', password: 'secret' })).rejects.toThrow(
      'Unable to reach the auth API. Checked /auth-api, https://viewer.example.com/auth-api, https://viewer.example.com:8788, http://viewer.example.com:8788, http://192.168.4.249:8788. Verify the auth server is running or set VITE_AUTH_API.'
    );

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('preserves server validation errors instead of masking them as fetch failures', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Current password is incorrect' }),
      })
    );

    const api = await import('@/lib/sessionApi');

    await expect(
      api.changeSessionPassword({
        currentPassword: 'wrong-password',
        nextPassword: 'NextPassword1',
      })
    ).rejects.toThrow('Current password is incorrect');

    vi.unstubAllGlobals();
    vi.resetModules();
  });
});
