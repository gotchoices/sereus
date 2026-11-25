import debug from 'debug';
import type { ArachnodeConfig } from './types.js';
import type { NodeClass } from './node-class.js';

const log = debug('sereus:cadre:arachnode');

/**
 * Ring configuration for a storage node
 */
export interface RingConfig {
  /** Ring number (0 = full keyspace, higher = more partitions) */
  ring: number;
  /** Partition within the ring (depends on ring level) */
  partition: number;
  /** Keyspace range this node is responsible for */
  keyspaceStart: Uint8Array;
  keyspaceEnd: Uint8Array;
}

/**
 * Stub implementation of Arachnode ring participation.
 * 
 * Arachnode uses a concentric ring system where:
 * - Ring Zulu (transaction ring): All nodes participate for transaction verification
 * - Storage rings (0, 1, 2, 3...): Nodes join based on their storage capacity
 *   - Ring 0: Full keyspace (requires most storage)
 *   - Ring 1: 2 partitions
 *   - Ring 2: 4 partitions
 *   - Ring 3: 8 partitions
 *   - etc.
 * 
 * This is a stub that will be replaced when arachnode is fully implemented.
 */
export class ArachnodeStub {
  private readonly nodeClass: NodeClass;
  private readonly config: ArachnodeConfig;
  private ringConfig?: RingConfig;
  private running = false;

  constructor(nodeClass: NodeClass, config: ArachnodeConfig) {
    this.nodeClass = nodeClass;
    this.config = config;
    log('ArachnodeStub created for nodeClass=%s, config=%o', nodeClass, config);
  }

  /**
   * Start participating in rings
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.config.enableRingZulu) {
      log('Joining Ring Zulu (transaction ring)');
      // Stub: In real implementation, would register with transaction verification network
    }

    // Always-on nodes join storage rings
    if (this.nodeClass === 'server' && this.config.storageRing) {
      const { ring, partition = 0 } = this.config.storageRing;
      
      log('Joining storage ring %d, partition %d', ring, partition);
      
      // Calculate keyspace range for this partition
      // Stub: Using placeholder keyspace calculation
      this.ringConfig = {
        ring,
        partition,
        keyspaceStart: this.calculateKeyspaceStart(ring, partition),
        keyspaceEnd: this.calculateKeyspaceEnd(ring, partition)
      };
      
      // Stub: In real implementation, would:
      // 1. Register with the storage ring
      // 2. Begin accepting block storage requests for our keyspace
      // 3. Participate in replication with other ring members
    }

    log('ArachnodeStub started');
  }

  /**
   * Stop participating in rings
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.ringConfig) {
      log('Leaving storage ring %d, partition %d', 
          this.ringConfig.ring, this.ringConfig.partition);
      // Stub: In real implementation, would gracefully leave the ring
      this.ringConfig = undefined;
    }

    if (this.config.enableRingZulu) {
      log('Leaving Ring Zulu');
      // Stub: In real implementation, would leave transaction ring
    }

    log('ArachnodeStub stopped');
  }

  /**
   * Get current ring configuration
   */
  getRingConfig(): RingConfig | undefined {
    return this.ringConfig;
  }

  /**
   * Check if participating in Ring Zulu
   */
  isInRingZulu(): boolean {
    return this.running && this.config.enableRingZulu;
  }

  /**
   * Check if participating in a storage ring
   */
  isInStorageRing(): boolean {
    return this.running && this.ringConfig !== undefined;
  }

  // Stub keyspace calculations
  private calculateKeyspaceStart(ring: number, partition: number): Uint8Array {
    // Stub: Real implementation would calculate based on ring partition scheme
    const numPartitions = Math.pow(2, ring);
    const partitionSize = 256 / numPartitions;
    const start = new Uint8Array(32);
    start[0] = Math.floor(partition * partitionSize);
    return start;
  }

  private calculateKeyspaceEnd(ring: number, partition: number): Uint8Array {
    // Stub: Real implementation would calculate based on ring partition scheme
    const numPartitions = Math.pow(2, ring);
    const partitionSize = 256 / numPartitions;
    const end = new Uint8Array(32);
    end[0] = Math.floor((partition + 1) * partitionSize) - 1;
    end.fill(0xFF, 1); // Fill rest with max values
    return end;
  }
}

/**
 * Create an arachnode instance for a strand
 *
 * NOTE: the node class, not the `alwaysOn` node role every other behaviour now follows
 * (`node-roles.ts`). Nothing in this repo calls this, and the storage rings it hands out are
 * unimplemented (`backlog/later/5-ring-zulu-storage-rings`), so the divergence reaches nobody —
 * but it means a `device` told `roles: { alwaysOn: true }` joins the real Ring Zulu and would
 * still be given no storage ring here. Take `NodeRoles` instead of a class when the rings are
 * built; the signature is exported, so that is a breaking change rather than a rename.
 */
export function createArachnodeStub(
  nodeClass: NodeClass, 
  config?: Partial<ArachnodeConfig>
): ArachnodeStub {
  const fullConfig: ArachnodeConfig = {
    enableRingZulu: config?.enableRingZulu ?? true,
    storageRing: nodeClass === 'server' ? (config?.storageRing ?? { ring: 0 }) : undefined
  };
  
  return new ArachnodeStub(nodeClass, fullConfig);
}

