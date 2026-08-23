/**
 * Owner-deactivation guard: when the admin who connected a cloud drive is
 * deactivated, disconnect those rows (imported documents stay).
 */
import { AppDataSource } from "../../database/data-source";
import { StorageConnection } from "../../database/entities/StorageConnection";
import { logger } from "../../utils/logger";
import { disconnectStorageConnection } from "./google-drive.service";

export async function flagConnectionsForDeactivatedOwner(
  userId: string,
): Promise<void> {
  try {
    const owned = await AppDataSource.getRepository(StorageConnection).find({
      where: { connectedByUserId: userId, status: "active" },
    });
    for (const row of owned) {
      await disconnectStorageConnection(row.tenantId, row.id);
    }
  } catch (err) {
    // Never block deactivation on this bookkeeping.
    logger.warn("[storage-owner] revoke on deactivation failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
