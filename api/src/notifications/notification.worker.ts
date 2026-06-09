/**
 * Push delivery worker. Processes the Bull `notifications` queue: loads the
 * notification, sends to all of the recipient's valid devices via Expo Push,
 * records per-device deliveries, and retires tokens Expo reports as dead.
 * Safely no-ops when the recipient has no registered devices.
 */
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { Job } from 'bull';
import { IsNull, type DataSource } from 'typeorm';

import { Notification } from '../database/entities/Notification';
import { MobileDevice } from '../database/entities/MobileDevice';
import { NotificationDelivery } from '../database/entities/NotificationDelivery';
import { logger } from '../utils/logger';

export function createNotificationProcessor(dataSource: DataSource) {
  const expo = new Expo();

  return async (job: Job): Promise<void> => {
    const { notificationId } = (job.data ?? {}) as { notificationId?: string };
    if (!notificationId) return;

    const notifRepo = dataSource.getRepository(Notification);
    const deviceRepo = dataSource.getRepository(MobileDevice);
    const deliveryRepo = dataSource.getRepository(NotificationDelivery);

    const notif = await notifRepo.findOne({ where: { id: notificationId } });
    if (!notif) return;

    const devices = (
      await deviceRepo.find({ where: { userId: notif.recipientUserId, revokedAt: IsNull() } })
    ).filter((d) => Expo.isExpoPushToken(d.expoPushToken));
    if (devices.length === 0) return;

    const messages: ExpoPushMessage[] = devices.map((d) => ({
      to: d.expoPushToken,
      title: notif.title,
      body: notif.message,
      sound: 'default',
      data: { notificationId: notif.id, type: notif.type, ...(notif.data ?? {}) },
    }));

    const chunks = expo.chunkPushNotifications(messages);
    let i = 0;
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        for (const ticket of tickets) {
          const device = devices[i++];
          await deliveryRepo.save(
            deliveryRepo.create({
              notificationId: notif.id,
              deviceId: device.id,
              status: ticket.status === 'ok' ? 'sent' : 'failed',
              ticketId: ticket.status === 'ok' ? ticket.id : undefined,
              error: ticket.status === 'error' ? ticket.message : undefined,
            }),
          );
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            await deviceRepo.update({ id: device.id }, { revokedAt: new Date() });
          }
        }
      } catch (err) {
        i += chunk.length;
        logger.error('Push chunk send failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
