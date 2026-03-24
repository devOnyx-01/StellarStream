import { prisma as defaultPrisma } from '../lib/db.js';
import { logger } from '../logger.js';

export interface CleanupResult {
  updatedCount: number;
}

/**
 * Minimal structural interface for the Prisma client methods this service needs.
 * Using a structural type instead of the concrete PrismaClient class makes the
 * service testable with lightweight mocks and decouples it from generated-client
 * version differences.
 */
interface StreamDb {
  stream: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

/**
 * Transitions ACTIVE streams whose endTime has elapsed to COMPLETED status.
 *
 * Uses a single bulk updateMany for efficiency — O(1) DB round-trips
 * regardless of how many streams have expired.
 */
export class StaleStreamCleanupService {
  private readonly db: StreamDb;

  constructor(db: StreamDb = defaultPrisma as unknown as StreamDb) {
    this.db = db;
  }

  async markExpiredStreamsCompleted(): Promise<CleanupResult> {
    const now = new Date();

    try {
      const result = await this.db.stream.updateMany({
        where: {
          status: 'ACTIVE',
          endTime: { lt: now },
        },
        data: {
          status: 'COMPLETED',
        },
      });

      logger.info('Stale stream cleanup completed', { updatedCount: result.count });
      return { updatedCount: result.count };
    } catch (error) {
      logger.error('Stale stream cleanup failed', error);
      throw error;
    }
  }
}
