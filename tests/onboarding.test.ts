import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnv, setupAdmin, type TestEnv } from './helpers';

let env: TestEnv; let fetchSpy: ReturnType<typeof vi.spyOn>;
const post = (body: object, e: TestEnv = env) => request(e.built.app).post('/api/admin/onboarding').send(body);
const session = async (e: TestEnv = env) => (await request(e.built.app).get('/api/admin/session')).body;

beforeEach(() => { env = createEnv(); fetchSpy = vi.spyOn(globalThis, 'fetch'); });
afterEach(() => { fetchSpy.mockRestore(); env.cleanup(); });

describe('one-time onboarding (the browser submits to FormSubmit; the server only records completion)', () => {
  it('is required on a brand-new install, before any admin exists', async () => {
    expect(await session()).toMatchObject({ setupRequired: true, authenticated: false, onboardingDone: false });
  });

  it('records completion once and then never asks again', async () => {
    const res = await post({ delivered: true });
    expect(res.status).toBe(201);
    expect((await session()).onboardingDone).toBe(true);
    expect((await post({ delivered: true })).body).toMatchObject({ success: true, alreadyDone: true });
    expect(env.built.ctx.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type = 'onboarding_completed'").get()).toEqual({ c: 1 });
  });

  it('never contacts any external service itself, so a blocked or offline server cannot break it', async () => {
    await post({ delivered: true });
    await post({ skip: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays done after the admin account is created and across a restart', async () => {
    await post({ delivered: true });
    await setupAdmin(env);
    expect(await session()).toMatchObject({ onboardingDone: true, setupRequired: false });
    env.built.close();
    const restarted = createEnv(env.config, env.root);
    try { expect((await session(restarted)).onboardingDone).toBe(true); expect((await post({ delivered: true }, restarted)).body.alreadyDone).toBe(true); }
    finally { restarted.built.close(); }
    env = createEnv(env.config, env.root);
  });

  it('is never shown to an installation that already has an admin (upgrade safety)', async () => {
    await setupAdmin(env);
    expect((await session()).onboardingDone).toBe(true);
  });

  it('can be skipped', async () => {
    expect((await post({ skip: true })).status).toBe(201);
    expect((await session()).onboardingDone).toBe(true);
    expect(env.built.ctx.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type = 'onboarding_skipped'").get()).toEqual({ c: 1 });
  });

  it('rejects empty requests and foreign origins', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ delivered: false })).status).toBe(400);
    const evil = await request(env.built.app).post('/api/admin/onboarding').set('Origin', 'https://evil.example').send({ delivered: true });
    expect(evil.status).toBe(403);
    expect((await session()).onboardingDone).toBe(false);
  });

  it('allows the browser to reach formsubmit.co under the production Content-Security-Policy, and nothing else external', async () => {
    const csp = String((await request(env.built.app).get('/api/v1/health')).headers['content-security-policy']);
    expect(csp).toMatch(/connect-src 'self' https:\/\/formsubmit\.co(;|$)/);
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).not.toMatch(/\*/);
  });
});
