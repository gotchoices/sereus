/**
 * Storage abstraction for provider state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import debug from 'debug';
import type { Container, ApiKey, CustomerBilling, UsageMetrics } from '../types.js';
import type { StorageConfig } from '../config/types.js';

const log = debug('cadre:provider:store');

/** Store interface for provider data */
export interface ProviderStore {
  // Container operations
  getContainer(id: string): Promise<Container | undefined>;
  listContainers(customerId?: string): Promise<Container[]>;
  saveContainer(container: Container): Promise<void>;
  deleteContainer(id: string): Promise<boolean>;

  // API key operations
  getApiKey(keyHash: string): Promise<ApiKey | undefined>;
  saveApiKey(key: ApiKey): Promise<void>;
  deleteApiKey(keyHash: string): Promise<boolean>;

  // Billing operations
  getCustomerBilling(customerId: string): Promise<CustomerBilling | undefined>;
  saveCustomerBilling(billing: CustomerBilling): Promise<void>;

  // Usage metrics
  saveUsageMetrics(metrics: UsageMetrics): Promise<void>;
  getUsageMetrics(containerId: string, periodStart: Date, periodEnd: Date): Promise<UsageMetrics[]>;
}

/** In-memory store implementation for testing */
export class MemoryStore implements ProviderStore {
  private containers = new Map<string, Container>();
  private apiKeys = new Map<string, ApiKey>();
  private customerBilling = new Map<string, CustomerBilling>();
  private usageMetrics: UsageMetrics[] = [];

  async getContainer(id: string): Promise<Container | undefined> {
    return this.containers.get(id);
  }

  async listContainers(customerId?: string): Promise<Container[]> {
    const all = Array.from(this.containers.values());
    return customerId ? all.filter(c => c.customerId === customerId) : all;
  }

  async saveContainer(container: Container): Promise<void> {
    this.containers.set(container.id, container);
  }

  async deleteContainer(id: string): Promise<boolean> {
    return this.containers.delete(id);
  }

  async getApiKey(keyHash: string): Promise<ApiKey | undefined> {
    return this.apiKeys.get(keyHash);
  }

  async saveApiKey(key: ApiKey): Promise<void> {
    this.apiKeys.set(key.keyHash, key);
  }

  async deleteApiKey(keyHash: string): Promise<boolean> {
    return this.apiKeys.delete(keyHash);
  }

  async getCustomerBilling(customerId: string): Promise<CustomerBilling | undefined> {
    return this.customerBilling.get(customerId);
  }

  async saveCustomerBilling(billing: CustomerBilling): Promise<void> {
    this.customerBilling.set(billing.customerId, billing);
  }

  async saveUsageMetrics(metrics: UsageMetrics): Promise<void> {
    this.usageMetrics.push(metrics);
  }

  async getUsageMetrics(containerId: string, periodStart: Date, periodEnd: Date): Promise<UsageMetrics[]> {
    return this.usageMetrics.filter(
      m =>
        m.containerId === containerId &&
        m.periodStart >= periodStart &&
        m.periodEnd <= periodEnd
    );
  }
}

/** File-based store implementation */
export class FileStore implements ProviderStore {
  private readonly dataDir: string;
  private cache: {
    containers: Map<string, Container>;
    apiKeys: Map<string, ApiKey>;
    customerBilling: Map<string, CustomerBilling>;
  } | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    log('FileStore initialized at: %s', dataDir);
  }

  private async loadCache(): Promise<void> {
    if (this.cache) return;

    this.cache = {
      containers: new Map(),
      apiKeys: new Map(),
      customerBilling: new Map(),
    };

    const containersFile = path.join(this.dataDir, 'containers.json');
    if (fs.existsSync(containersFile)) {
      const data = JSON.parse(fs.readFileSync(containersFile, 'utf-8'));
      for (const c of data) {
        c.createdAt = new Date(c.createdAt);
        c.updatedAt = new Date(c.updatedAt);
        this.cache.containers.set(c.id, c);
      }
    }

    const apiKeysFile = path.join(this.dataDir, 'api-keys.json');
    if (fs.existsSync(apiKeysFile)) {
      const data = JSON.parse(fs.readFileSync(apiKeysFile, 'utf-8'));
      for (const k of data) {
        k.createdAt = new Date(k.createdAt);
        if (k.lastUsedAt) k.lastUsedAt = new Date(k.lastUsedAt);
        if (k.expiresAt) k.expiresAt = new Date(k.expiresAt);
        this.cache.apiKeys.set(k.keyHash, k);
      }
    }

    const billingFile = path.join(this.dataDir, 'customer-billing.json');
    if (fs.existsSync(billingFile)) {
      const data = JSON.parse(fs.readFileSync(billingFile, 'utf-8'));
      for (const b of data) {
        b.currentPeriodStart = new Date(b.currentPeriodStart);
        b.currentPeriodEnd = new Date(b.currentPeriodEnd);
        this.cache.customerBilling.set(b.customerId, b);
      }
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cache) return;

    const containersFile = path.join(this.dataDir, 'containers.json');
    fs.writeFileSync(containersFile, JSON.stringify(Array.from(this.cache.containers.values()), null, 2));

    const apiKeysFile = path.join(this.dataDir, 'api-keys.json');
    fs.writeFileSync(apiKeysFile, JSON.stringify(Array.from(this.cache.apiKeys.values()), null, 2));

    const billingFile = path.join(this.dataDir, 'customer-billing.json');
    fs.writeFileSync(billingFile, JSON.stringify(Array.from(this.cache.customerBilling.values()), null, 2));
  }

  async getContainer(id: string): Promise<Container | undefined> {
    await this.loadCache();
    return this.cache!.containers.get(id);
  }

  async listContainers(customerId?: string): Promise<Container[]> {
    await this.loadCache();
    const all = Array.from(this.cache!.containers.values());
    return customerId ? all.filter(c => c.customerId === customerId) : all;
  }

  async saveContainer(container: Container): Promise<void> {
    await this.loadCache();
    this.cache!.containers.set(container.id, container);
    await this.saveCache();
  }

  async deleteContainer(id: string): Promise<boolean> {
    await this.loadCache();
    const result = this.cache!.containers.delete(id);
    await this.saveCache();
    return result;
  }
  // API key and billing methods follow same pattern - abbreviated for file length
  async getApiKey(keyHash: string): Promise<ApiKey | undefined> {
    await this.loadCache();
    return this.cache!.apiKeys.get(keyHash);
  }
  async saveApiKey(key: ApiKey): Promise<void> {
    await this.loadCache();
    this.cache!.apiKeys.set(key.keyHash, key);
    await this.saveCache();
  }
  async deleteApiKey(keyHash: string): Promise<boolean> {
    await this.loadCache();
    const r = this.cache!.apiKeys.delete(keyHash);
    await this.saveCache();
    return r;
  }
  async getCustomerBilling(customerId: string): Promise<CustomerBilling | undefined> {
    await this.loadCache();
    return this.cache!.customerBilling.get(customerId);
  }
  async saveCustomerBilling(billing: CustomerBilling): Promise<void> {
    await this.loadCache();
    this.cache!.customerBilling.set(billing.customerId, billing);
    await this.saveCache();
  }
  async saveUsageMetrics(_metrics: UsageMetrics): Promise<void> {
    // Append to metrics log file
    const metricsFile = path.join(this.dataDir, 'usage-metrics.jsonl');
    fs.appendFileSync(metricsFile, JSON.stringify(_metrics) + '\n');
  }
  async getUsageMetrics(containerId: string, periodStart: Date, periodEnd: Date): Promise<UsageMetrics[]> {
    const metricsFile = path.join(this.dataDir, 'usage-metrics.jsonl');
    if (!fs.existsSync(metricsFile)) return [];
    const lines = fs.readFileSync(metricsFile, 'utf-8').split('\n').filter(Boolean);
    return lines
      .map(l => JSON.parse(l) as UsageMetrics)
      .filter(
        m =>
          m.containerId === containerId &&
          new Date(m.periodStart) >= periodStart &&
          new Date(m.periodEnd) <= periodEnd
      );
  }
}

/** Create a store based on configuration */
export function createStore(config: StorageConfig): ProviderStore {
  if (config.type === 'file' && config.path) {
    return new FileStore(config.path);
  }
  return new MemoryStore();
}

