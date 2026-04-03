const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return escapeHtml(variables[key]);
    }
    return _match;
  });
}

const EVENT_VARIABLES: Record<string, string[]> = {
  'appointment.booked': ['name', 'email', 'date', 'time', 'tenantName', 'botName'],
  'lead.created': ['name', 'email', 'phone', 'tenantName', 'botName'],
  'conversation.ended': ['messageCount', 'duration', 'tags', 'tenantName', 'botName'],
};

export function getAvailableVariables(eventType: string): string[] {
  return EVENT_VARIABLES[eventType] ?? [];
}

export interface WebhookEvent {
  type: string;
  data?: Record<string, unknown>;
}

export function buildVariablesFromEvent(
  event: WebhookEvent,
  tenantName: string,
  botName: string
): Record<string, string> {
  const base: Record<string, string> = {
    tenantName,
    botName,
  };

  const data = event.data ?? {};

  switch (event.type) {
    case 'appointment.booked':
      return {
        ...base,
        name: String(data.name ?? ''),
        email: String(data.email ?? ''),
        date: String(data.date ?? ''),
        time: String(data.time ?? ''),
      };

    case 'lead.created':
      return {
        ...base,
        name: String(data.name ?? ''),
        email: String(data.email ?? ''),
        phone: String(data.phone ?? ''),
      };

    case 'conversation.ended':
      return {
        ...base,
        messageCount: String(data.messageCount ?? ''),
        duration: String(data.duration ?? ''),
        tags: Array.isArray(data.tags) ? (data.tags as string[]).join(', ') : String(data.tags ?? ''),
      };

    default:
      return base;
  }
}
