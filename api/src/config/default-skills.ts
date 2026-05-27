/**
 * Default skills provisioned for every new tenant.
 * These define what the bot can do out of the box.
 * Super admins can later customize per tenant via the portal.
 */

export interface DefaultSkill {
  name: string;
  displayName: string;
  description: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps: number;
  enabled: boolean;
}

export const DEFAULT_SKILLS: DefaultSkill[] = [
  {
    name: 'answer_questions',
    displayName: 'Answer Questions',
    description: 'Uses your knowledge base to answer visitor questions about your business, products, or services.',
    trigger: 'User asks a question that can be answered from the knowledge base',
    tools: ['kb_search'],
    instructions: 'Search the knowledge base for relevant information. Provide a clear, concise answer based on the results. If no relevant information is found, let the user know and offer to connect them with a team member.',
    maxSteps: 3,
    enabled: true,
  },
  {
    name: 'capture_leads',
    displayName: 'Lead Capture',
    description: 'Collects visitor contact information like name, email, and phone number when they show interest.',
    trigger: 'User expresses interest in a product or service, asks for pricing, or wants to be contacted',
    tools: ['capture_lead'],
    instructions: 'When a visitor shows interest, naturally ask for their name and email. Be conversational, not pushy. Capture the lead with any relevant context about what they were interested in.',
    maxSteps: 5,
    enabled: true,
  },
  {
    name: 'handoff_to_human',
    displayName: 'Human Handoff',
    description: 'Connects visitors to a live team member when the bot cannot help or when requested.',
    trigger: 'User asks to speak with a human, expresses frustration, or the bot cannot answer their question',
    tools: ['escalate_to_human'],
    instructions: 'When escalating, briefly summarize the conversation context so the human agent can pick up seamlessly. Let the visitor know they are being connected to a team member.',
    maxSteps: 2,
    enabled: true,
  },
  {
    name: 'appointments',
    displayName: 'Appointments',
    description: 'Lets visitors book, reschedule, or cancel appointments directly in the chat.',
    trigger: 'User wants to schedule, reschedule, cancel, or check availability for an appointment or meeting',
    tools: ['check_availability', 'create_booking', 'list_bookings', 'reschedule_booking', 'cancel_booking'],
    instructions: 'For new bookings: check available time slots, present options clearly, create the booking, and confirm details. For changes: ask for identifying information, find their booking, confirm the new details before applying. Always confirm cancellations before proceeding.',
    maxSteps: 8,
    enabled: false,
  },
];
