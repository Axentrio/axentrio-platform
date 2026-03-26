import { Router, Request, Response } from 'express';
import { Webhook } from 'svix';
import { AppDataSource } from '../database/data-source';
import { User } from '../database/entities/User';
import { logger } from '../utils/logger';
import { config } from '../config/environment';
import { asyncHandler, BadRequestError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';

const router = Router();

interface ClerkEmailAddress {
  email_address: string;
  verification: { status: string };
}

interface ClerkUserEvent {
  type: string;
  data: {
    id: string;
    email_addresses: ClerkEmailAddress[];
    primary_email_address_id: string;
  };
}

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const webhookSecret = config.clerk.webhookSecret;
  if (!webhookSecret) {
    logger.error('CLERK_WEBHOOK_SECRET not configured');
    throw new BadRequestError('Webhook not configured');
  }

  let payload: ClerkUserEvent;
  try {
    const wh = new Webhook(webhookSecret);
    const rawBody = req.body as Buffer;
    payload = wh.verify(
      rawBody.toString('utf8'),
      {
        'svix-id': req.headers['svix-id'] as string,
        'svix-timestamp': req.headers['svix-timestamp'] as string,
        'svix-signature': req.headers['svix-signature'] as string,
      }
    ) as ClerkUserEvent;
  } catch (error) {
    logger.error('Clerk webhook verification failed', { error });
    throw new BadRequestError('Webhook verification failed');
  }

  if (payload.type !== 'user.created' && payload.type !== 'user.updated') {
    sendSuccess(res, { received: true });
    return;
  }

  const { id: clerkUserId, email_addresses } = payload.data;
  const isVerified = email_addresses.some(
    (e) => e.verification?.status === 'verified'
  );

  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { clerkUserId } });

  if (user && user.emailVerified !== isVerified) {
    user.emailVerified = isVerified;
    await userRepo.save(user);
    logger.info('Updated email verification status', { clerkUserId, emailVerified: isVerified });
  }

  sendSuccess(res, { received: true });
}));

export default router;
