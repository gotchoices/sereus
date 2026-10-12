import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore } from '../store.js';
import type { CustomerBilling } from '../../types.js';

describe('FileStore customer billing persistence', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-store-')); });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('reloads customer billing after a restart', async () => {
    const billing: CustomerBilling = {
      customerId: 'cust-1',
      planId: 'professional',
      balanceCents: 500,
      currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      subscription: { status: 'active', renewsAt: new Date('2026-07-01T00:00:00.000Z'), lapsesAt: null },
    };
    const store = new FileStore(dataDir);
    await store.saveCustomerBilling(billing);

    const reloaded = new FileStore(dataDir); // simulated restart
    const result = await reloaded.getCustomerBilling('cust-1');

    expect(result).toBeDefined();
    expect(result?.planId).toBe('professional');
    expect(result?.balanceCents).toBe(500);
    expect(result?.currentPeriodStart).toBeInstanceOf(Date);
    expect(result?.currentPeriodStart.getTime()).toBe(billing.currentPeriodStart.getTime());
  });

  it('persists optional fields and rehydrates the period end and subscription dates as Dates', async () => {
    const billing: CustomerBilling = {
      customerId: 'cust-2',
      planId: 'starter',
      balanceCents: -250,
      paymentMethodId: 'pm_123',
      billingEmail: 'owner@example.com',
      currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      subscription: { status: 'past-due', renewsAt: null, lapsesAt: new Date('2026-07-08T00:00:00.000Z') },
    };
    const store = new FileStore(dataDir);
    await store.saveCustomerBilling(billing);

    const reloaded = new FileStore(dataDir);
    const result = await reloaded.getCustomerBilling('cust-2');

    expect(result?.paymentMethodId).toBe('pm_123');
    expect(result?.billingEmail).toBe('owner@example.com');
    expect(result?.balanceCents).toBe(-250);
    expect(result?.currentPeriodEnd).toBeInstanceOf(Date);
    expect(result?.currentPeriodEnd.getTime()).toBe(billing.currentPeriodEnd.getTime());
    // The lapse sweep compares lapsesAt with the clock; a string left by JSON never compares as due.
    expect(result?.subscription.lapsesAt).toBeInstanceOf(Date);
    expect(result?.subscription.lapsesAt?.getTime()).toBe(billing.subscription.lapsesAt?.getTime());
    expect(result?.subscription.renewsAt).toBeNull();
  });

  it('writes a customer-billing.json backing file', async () => {
    const store = new FileStore(dataDir);
    await store.saveCustomerBilling({
      customerId: 'cust-3',
      planId: 'enterprise',
      balanceCents: 0,
      currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      subscription: { status: 'active', renewsAt: new Date('2026-07-01T00:00:00.000Z'), lapsesAt: null },
    });

    const billingFile = path.join(dataDir, 'customer-billing.json');
    expect(fs.existsSync(billingFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(billingFile, 'utf-8')) as CustomerBilling[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].customerId).toBe('cust-3');
  });
});
