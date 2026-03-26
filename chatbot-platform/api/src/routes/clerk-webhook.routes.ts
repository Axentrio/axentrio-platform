import { Router, Request, Response } from 'express';
import { Webhook } from 'svix';
import { AppDataSource } from '../database/data-source';
import { User } from '../database/entities/User';
import { logger } from '../utils/logger';
import { config } from '../config/environment';

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

router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const webhookSecret = config.clerk.webhookSecret;
    if (!webhookSecret) {
      logger.error('CLERK_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'Webhook not configured' });
      return;
    }

    const wh = new Webhook(webhookSecret);
    const rawBody = req.body as Buffer;
    const payload = wh.verify(
      rawBody.toString('utf8'),
      {
        'svix-id': req.headers['svix-id'] as string,
        'svix-timestamp': req.headers['svix-timestamp'] as string,
        'svix-signature': req.headers['svix-signature'] as string,
      }
    ) as ClerkUserEvent;

    if (payload.type !== 'user.created' && payload.type !== 'user.updated') {
      res.status(200).json({ received: true });
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

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Clerk webhook processing failed', { error });
    res.status(400).json({ error: 'Webhook verification failed' });
  }
});

export default router;
