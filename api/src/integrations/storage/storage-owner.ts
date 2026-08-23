/**
 * Owner-deactivation guard: when the admin who connected a cloud drive is
 * deactivated, flag those connections so imports stop until someone reconnects.
 */
import { In } from "typeorm";
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { logAudit } from "../../utils/audit";
import { logger } from "../../utils/logger";

export async function flagConnectionsForDeactivatedOwner(userId: string): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(StorageConnection);
    const owned = await repo.find({
      where: { connectedByUserId: userId, status: "active", reauthRequired: false },
    });
    if (owned.length === 0) return;
    await repo.update(
      { id: In(owned.map((c) => c.id)) },
      { reauthRequired: true },
    );
    await logAudit(userId, "knowledge.storage.owner_deactivated", "storage_connection", owned[0].id, owned[0].tenantId, {
      connectionIds: owned.map((c) => c.id),
      provider: owned[0].provider,
    });
  } catch (err) {
    // Never block deactivation on this bookkeeping.
    logger.warn("[storage-owner] flagging connections failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
