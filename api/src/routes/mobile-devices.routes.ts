/**
 * Mobile Device Routes
 * Push-token registration for the mobile app. Agent-authenticated.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler } from '../middleware/error-handler';
import { sendCreated, sendNoContent } from '../utils/response';
import { notificationService } from '../services/notification.service';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/** POST /mobile/devices — register (or refresh) this device's push token. */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const body = (req.body ?? {}) as Record<string, string | undefined>;

    if (!body.expoPushToken || !body.platform) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'expoPushToken and platform are required' },
      });
      return;
    }

    const device = await notificationService.registerDevice({
      tenantId: authReq.tenantId!,
      userId: authReq.userId!,
      clerkUserId: authReq.clerkUserId,
      expoPushToken: body.expoPushToken,
      nativeToken: body.nativeToken,
      platform: body.platform,
      deviceId: body.deviceId,
      appVersion: body.appVersion,
      buildNumber: body.buildNumber,
      runtimeVersion: body.runtimeVersion,
      locale: body.locale,
      timezone: body.timezone,
      permissionStatus: body.permissionStatus,
      environment: body.environment,
    });

    sendCreated(res, { id: device.id });
  }),
);

/** DELETE /mobile/devices — unregister this device's push token. */
router.delete(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const token = (req.body?.expoPushToken ?? req.query.expoPushToken) as string | undefined;
    if (token) await notificationService.unregisterDevice(authReq.userId!, token);
    sendNoContent(res);
  }),
);

export default router;
