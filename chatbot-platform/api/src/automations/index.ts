import { config } from '../config/environment';
import { EmailService } from './email.service';
import { AutomationEngine } from './automation.engine';

let emailService: EmailService | null = null;
let automationEngine: AutomationEngine | null = null;

export function initializeAutomations(): void {
  emailService = new EmailService(config.email.resendApiKey, config.email.fromAddress);
  automationEngine = new AutomationEngine(emailService);
}

export function getAutomationEngine(): AutomationEngine | null {
  return automationEngine;
}

export function getEmailService(): EmailService {
  if (!emailService) {
    throw new Error('EmailService not initialized — call initializeAutomations() first');
  }
  return emailService;
}
