export interface FaqItem {
  q: string;
  a: string;
}

export interface FaqSection {
  id: string;
  title: string;
  items: FaqItem[];
}

export const FAQ_DOC_FILENAME = 'HandsOff_FAQ.docx';
export const FAQ_DOC_PATH = `/${FAQ_DOC_FILENAME}`;

export const faqSections: FaqSection[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    items: [
      {
        q: 'What is HandsOff?',
        a: 'HandsOff is an AI-powered automation platform that helps businesses automate customer conversations across multiple channels. It combines an intelligent AI chatbot, live agent handoff, analytics, and team management tools into one unified dashboard.',
      },
      {
        q: 'How do I get started with HandsOff?',
        a: 'After signing up, follow the setup checklist in your Analytics dashboard: (1) Enable your AI Assistant, (2) Configure your brand voice and bot identity, (3) Upload knowledge base documents, (4) Connect your booking calendar (optional), and (5) Set up automations. Each step has a direct link to the relevant settings page.',
      },
      {
        q: 'What channels can I connect to HandsOff?',
        a: 'HandsOff currently supports website chat widgets, Telegram bots, and Facebook Pages. You can manage all conversations from these channels in a single unified Inbox. Additional channels are added regularly.',
      },
      {
        q: 'Do I need coding skills to use HandsOff?',
        a: 'No. HandsOff is designed to be fully no-code. You can configure your AI bot, customize appearances, connect channels, and manage conversations entirely through the user-friendly dashboard. The only technical step is copying a small embed snippet to add the chat widget to your website.',
      },
      {
        q: 'Is there a free trial available?',
        a: 'Yes, HandsOff offers a free trial period so you can explore all features before committing. During the trial, you have full access to AI bot configuration, knowledge base uploads, channel connections, and analytics.',
      },
    ],
  },
  {
    id: 'ai-bot',
    title: 'AI Bot Configuration',
    items: [
      {
        q: "How do I configure my AI bot's identity?",
        a: 'Navigate to AI & Content > AI Bot. Here you can set your Chatbot Name (the display name visitors see), Support Email (used for escalations), Voice Tone (Friendly, Professional, Casual, Formal, or Custom), and detailed Bot Instructions that guide how your AI responds to visitors.',
      },
      {
        q: 'What are Bot Instructions and how do I use them?',
        a: 'Bot Instructions are system prompts that tell your AI how to behave. You can start from a template (Blank or FAQ-based) or write your own custom instructions. Use placeholders like {botName}, {tone}, {supportEmail}, {businessName}, {fallbackMessage}, {offHoursMessage}, {maxResponseLength}, and {topicsToAvoid} to make instructions dynamic.',
      },
      {
        q: "How do I change my bot's tone of voice?",
        a: 'In the AI Bot settings, select one of the five Voice Tone options: Friendly (warm and approachable), Professional (polite and business-focused), Casual (relaxed and conversational), Formal (strict and corporate), or Custom (define your own style in the Bot Instructions).',
      },
      {
        q: 'Can I temporarily disable the AI bot?',
        a: 'Yes. The AI Bot section has a toggle switch labeled "Enable AI-powered responses for visitors." Turning this off will disable automated responses while keeping your configuration intact for when you want to re-enable it.',
      },
      {
        q: 'What is the Greeting Message and how do I change it?',
        a: 'The Greeting Message is the first message visitors see when they open the chat widget. The default is "Welcome! How can I help you today?" You can customize this in the Advanced Settings section of the AI Bot tab.',
      },
    ],
  },
  {
    id: 'knowledge-base',
    title: 'Knowledge Base',
    items: [
      {
        q: 'What is the Knowledge Base?',
        a: 'The Knowledge Base is where you upload and store information that your AI bot uses to answer visitor questions. This can include PDF documents, pasted text, FAQs, product descriptions, pricing details, and company policies.',
      },
      {
        q: 'What file formats are supported for knowledge base uploads?',
        a: 'Currently, you can upload PDF documents, paste plain text directly, or manually add FAQ entries. The AI processes this content and uses it to provide accurate, context-aware responses to visitor inquiries.',
      },
      {
        q: 'How do I add documents to the knowledge base?',
        a: 'Go to AI & Content > Knowledge Base and click "Add Document" or "Add your first document." You can then upload PDFs or paste text. Once uploaded, the AI will automatically reference this content when answering relevant questions.',
      },
      {
        q: 'Does the AI bot only answer from the knowledge base?',
        a: 'The AI primarily answers from your knowledge base to ensure accuracy and brand consistency. However, it can also use its general intelligence for conversational pleasantries, clarifying questions, and handling topics not covered in your documents. You control this balance through Bot Instructions.',
      },
      {
        q: 'How do I update or remove knowledge base content?',
        a: "Navigate to AI & Content > Knowledge Base. You'll see a list of all uploaded documents with search functionality. You can delete outdated documents and add new ones at any time. The AI updates its responses automatically based on the current knowledge base content.",
      },
    ],
  },
  {
    id: 'custom-responses',
    title: 'Custom Responses',
    items: [
      {
        q: 'What are Custom Responses?',
        a: 'Custom Responses (also called canned responses) are pre-written answers to common questions. They ensure consistency across conversations and help your AI deliver precise, approved messaging for specific topics.',
      },
      {
        q: 'How do I create a Custom Response?',
        a: 'Go to AI & Content > Custom Responses and click "New Response." Fill in the Title (for internal reference), Content (the actual message), Shortcut (a quick code to trigger it), Category (for organization), and Scope (which contexts it applies to).',
      },
      {
        q: 'Can I organize Custom Responses by category?',
        a: 'Yes. You can assign categories to each custom response and filter by category using the dropdown menu. This makes it easy to manage responses for different departments, products, or conversation topics.',
      },
      {
        q: 'How does the AI know when to use a Custom Response?',
        a: 'Custom Responses can be triggered by shortcuts (typed by agents), or the AI can be instructed to use specific responses for certain topics through your Bot Instructions. The USED column in the responses table shows how often each response has been utilized.',
      },
    ],
  },
  {
    id: 'appearance',
    title: 'Chatbot Appearance & Branding',
    items: [
      {
        q: "How do I customize the chat widget's appearance?",
        a: 'Go to AI & Content > Chatbot Appearances. You can set the Primary Color, Bot Avatar URL, Launcher Position (Bottom Right or Bottom Left), Launcher Label (text next to the chat icon), and preview all changes in real-time.',
      },
      {
        q: 'Can I use my company logo as the bot avatar?',
        a: 'Yes. In the Chatbot Appearances tab, enter a URL to your logo image in the "Bot avatar URL" field. If left empty, the widget will automatically use your company logo when available. The recommended size is 256x256px in PNG or SVG format.',
      },
      {
        q: 'What is the Launcher Label and how do I change it?',
        a: 'The Launcher Label is the text displayed next to the chat icon on your website, such as "Chat with us." You can customize this text in the Chatbot Appearances section to match your brand voice.',
      },
      {
        q: 'Where does the Welcome Message appear?',
        a: 'The Welcome Message appears at the top of the chat widget when a visitor first opens it. It is configured in the AI Bot settings under Advanced Settings, not in the Appearances tab.',
      },
      {
        q: 'Can I preview my chat widget before going live?',
        a: 'Yes. The Chatbot Appearances tab includes a live preview panel showing exactly how your widget will look to visitors. You can also click "Open full widget test" to see the complete experience, and use "Test Chat" from any page to interact with your bot.',
      },
    ],
  },
  {
    id: 'channels',
    title: 'Channels & Social Media',
    items: [
      {
        q: 'Which messaging platforms does HandsOff support?',
        a: 'Currently, HandsOff supports Telegram bots and Facebook Pages. You can connect one or both platforms, and all messages will flow into your unified Inbox for centralized management.',
      },
      {
        q: 'How do I connect a Telegram bot?',
        a: 'Go to AI & Content > Social Media Integrations or Settings > Channels. Click the Telegram button and follow the instructions to link your existing Telegram bot using its API token. Once connected, all messages sent to your bot will appear in the Inbox.',
      },
      {
        q: 'How do I connect a Facebook Page?',
        a: 'In the Social Media Integrations or Channels section, click the Facebook button and authenticate with your Facebook account. Select the Page you want to connect, and HandsOff will automatically receive and respond to messages sent to that Page.',
      },
      {
        q: 'Can I manage all channels from one inbox?',
        a: 'Yes. The Inbox dashboard consolidates conversations from your website widget, Telegram, and Facebook into a single view. You can filter by channel using the tabs: All, Bot, Handoff, and Agent.',
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics & Reporting',
    items: [
      {
        q: 'What metrics does HandsOff track?',
        a: 'HandsOff provides comprehensive analytics including: Active Chats, Pending Handoffs, Online Agents, Average Response Time, CSAT (Customer Satisfaction) Score, and Total Chats. You can view trends over time with the Last 7 Days filter (other time ranges available).',
      },
      {
        q: 'What is the Chat Volume graph?',
        a: 'The Chat Volume graph shows the number of conversations over time, broken down by Bot (AI-handled), Human (agent-handled), and Handoff (transferred) conversations. This helps you understand how workload is distributed between AI and your team.',
      },
      {
        q: 'Can I export my analytics data?',
        a: 'Yes. The Analytics dashboard includes an Export button that allows you to download your performance data for further analysis or reporting in external tools.',
      },
      {
        q: 'What is the setup checklist in Analytics?',
        a: 'The checklist at the top of the Analytics page tracks your onboarding progress: AI Assistant enabled, Brand voice configured, Knowledge base docs uploaded, Booking calendar connected, and Automations set up. Each item links directly to the relevant configuration page.',
      },
    ],
  },
  {
    id: 'team',
    title: 'Team Management',
    items: [
      {
        q: 'How do I invite team members to HandsOff?',
        a: 'Go to the Team section and click "Invite" in the Members tab. Enter the email address of the person you want to invite, and they will receive an invitation to join your organization.',
      },
      {
        q: 'What roles are available in HandsOff?',
        a: 'The primary role shown is Admin, which has full access to all settings and features. You can manage member roles through the dropdown in the Members table. Additional role tiers may be available depending on your plan.',
      },
      {
        q: 'How do I add a live agent?',
        a: 'In the Team section, click "Add Agent." You can set up agent profiles, assign shifts, and track performance metrics. Agents appear in the Agents tab with their online status and chat assignments.',
      },
      {
        q: 'Can I schedule shifts for my team?',
        a: 'Yes. The Team section includes a Shifts tab where you can create and manage agent schedules. This ensures coverage during peak hours and helps balance workload across your team.',
      },
      {
        q: 'What team statistics are available?',
        a: 'The Team dashboard shows Total Agents, Online Now (current active agents), Total Chats Month-to-Date, and Average CSAT Score. The Performance tab provides individual agent metrics for coaching and recognition.',
      },
    ],
  },
  {
    id: 'handoff',
    title: 'Human Handoff',
    items: [
      {
        q: 'What is Human Handoff?',
        a: 'Human Handoff is a feature that seamlessly transfers conversations from the AI bot to a live human agent when the bot cannot resolve an inquiry or when a visitor explicitly requests to speak with a person.',
      },
      {
        q: 'How does a visitor request a human agent?',
        a: 'Visitors can request a human agent at any time during the conversation. The AI is trained to recognize phrases like "speak to a human," "talk to an agent," or "I need help from a person" and will initiate the handoff automatically.',
      },
      {
        q: 'Where do handoff requests appear?',
        a: 'Handoff requests appear in the Inbox under the "Handoff" tab. Agents can see pending handoffs and claim them to start the conversation. The Inbox also shows real-time metrics for Pending Handoffs.',
      },
      {
        q: 'Can the AI resume a conversation after handoff?',
        a: 'The AI maintains context throughout the conversation. After a human agent resolves the issue and closes the chat, the AI can resume handling new inquiries from that visitor with full awareness of the conversation history.',
      },
      {
        q: 'How do I enable or disable Human Handoff?',
        a: 'Human Handoff can be toggled in Settings > Capabilities. Look for the "Human Handoff" card and toggle it on or off. When enabled, the AI will automatically offer to connect visitors with a human agent when appropriate.',
      },
    ],
  },
  {
    id: 'capabilities',
    title: 'Capabilities & Features',
    items: [
      {
        q: 'What capabilities can I enable for my chatbot?',
        a: 'HandsOff offers four main capabilities: Answer Questions (using your knowledge base), Lead Capture (collecting visitor contact information), Human Handoff (connecting to live agents), and Appointments (booking, rescheduling, and canceling meetings).',
      },
      {
        q: 'How does Lead Capture work?',
        a: 'When enabled, the chatbot collects visitor contact information such as name, email, and phone number when they show interest in your products or services. This data is captured automatically and can trigger team notifications.',
      },
      {
        q: 'Can the chatbot book appointments?',
        a: 'Yes, with the Appointments capability enabled, visitors can book, reschedule, or cancel appointments directly through the chat. The bot supports checking availability, creating bookings, listing existing bookings, rescheduling, and canceling.',
      },
      {
        q: 'How do I connect a booking calendar?',
        a: 'Go to Settings > Integrations and find the Appointment Booking section. Enter your Cal.com API key (found at Cal.com > Settings > Developer > API Keys) and click Connect. Once linked, the chatbot can manage your calendar automatically.',
      },
      {
        q: 'What are Team Notifications?',
        a: 'Team Notifications alert your team when important events occur. You can enable "New Lead Alert" to notify the team when a new lead is captured, and "Conversation Summary" to send a summary of each completed conversation to the team inbox.',
      },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations & API',
    items: [
      {
        q: 'Does HandsOff offer an API?',
        a: 'Yes. HandsOff provides API access for advanced integrations. Your unique API Key is available in Settings > Integrations. Use this key to authenticate API requests and build custom workflows.',
      },
      {
        q: 'What is the Webhook URL used for?',
        a: 'The Outbound Webhook URL in Settings > Integrations allows you to send conversation events, lead captures, and other data to external systems. Enter your webhook endpoint URL, test the connection, and save to start receiving real-time events.',
      },
      {
        q: 'What is the Inbound Webhook Endpoint?',
        a: 'The Inbound Webhook Endpoint is a read-only URL that allows external automation workflows to send messages or triggers into HandsOff. Include your tenant ID in the request body when configuring your external tools.',
      },
      {
        q: 'How do I secure my webhook connections?',
        a: 'Use the Webhook Secret (found in Settings > Integrations) to verify that incoming webhook requests are genuine. Configure your automation platform to include this secret key in request headers for secure authentication.',
      },
      {
        q: 'Can I regenerate my API key?',
        a: 'Yes. In Settings > Integrations, your API Key has a regenerate button next to it. Regenerating the key will invalidate the old one, so make sure to update any systems using the previous key immediately.',
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings & Account Management',
    items: [
      {
        q: 'How do I update my profile information?',
        a: 'Go to Settings > Profile. You can update your First Name and Last Name. Your email address is managed by Clerk (our authentication provider) and cannot be changed directly in HandsOff. Use the Clerk user menu to manage email and password.',
      },
      {
        q: 'How do notification settings work?',
        a: 'In Settings > Notifications, you can configure: Sound Notifications (with adjustable volume), Desktop Notifications (browser alerts), and Handoff Notifications Only (receive alerts only for handoff requests, not all messages).',
      },
      {
        q: 'Can I change the dashboard theme?',
        a: 'Yes. Go to Settings > Appearance and choose between Light, Dark, or System (follows your OS preference). This changes the appearance of your HandsOff dashboard only, not the chat widget.',
      },
      {
        q: 'How do I update my organization logo and display name?',
        a: 'Go to Settings > Widget & Brand. Upload your logo (recommended: 256x256px, PNG or SVG), update your Display Name, and view your active session status. These changes apply to the chat widget header that visitors see.',
      },
      {
        q: 'How do I embed the chat widget on my website?',
        a: "In Settings > Widget & Brand, you'll find the Embed Widget section with a ready-to-use HTML script snippet. Copy this snippet and paste it into your website's HTML, just before the closing </body> tag. The widget will appear immediately.",
      },
      {
        q: 'What are Active Sessions and Max Sessions?',
        a: "Active Sessions shows how many visitors are currently chatting with your bot. Max Sessions indicates your plan's session limit. If you approach this limit, consider upgrading your plan for uninterrupted service.",
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    items: [
      {
        q: 'My chatbot is not responding. What should I check?',
        a: 'First, verify that the AI Bot toggle is enabled in AI & Content > AI Bot. Next, check that you have content in your Knowledge Base. Ensure your widget embed code is correctly installed on your website. Finally, verify that your account status is active in Settings > Widget & Brand.',
      },
      {
        q: 'The chat widget is not showing on my website. Why?',
        a: 'Check that the embed script is placed before the closing </body> tag. Verify your API key in the script matches your current key in Settings > Integrations. Check browser console for JavaScript errors. Ensure no ad blockers or content security policies are blocking the widget.',
      },
      {
        q: 'My knowledge base documents are not being used by the AI. Why?',
        a: 'Ensure documents are successfully uploaded (check AI & Content > Knowledge Base for the document list). The AI only uses processed documents — give the system a few minutes after upload. Also verify that your Bot Instructions reference the knowledge base for answering questions.',
      },
      {
        q: 'Handoff requests are not reaching my agents. What should I do?',
        a: 'Ensure Human Handoff is enabled in Settings > Capabilities. Check that you have agents added in the Team section. Verify notification settings are configured correctly in Settings > Notifications. Confirm agents are online and available in the Inbox.',
      },
      {
        q: 'How do I reset my password?',
        a: 'HandsOff uses Clerk for authentication. To change your password, use the Clerk user menu (accessible from your profile dropdown) or visit your Clerk account settings directly.',
      },
      {
        q: 'Where can I get additional support?',
        a: 'If you need help beyond this FAQ, contact our support team using the Support Email configured in your AI Bot settings. You can also check the HandsOff documentation portal for detailed guides and video tutorials.',
      },
    ],
  },
];
