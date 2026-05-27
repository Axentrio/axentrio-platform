import React, { useState, useEffect } from 'react';
import {
  Mail,
  ChevronDown,
  ChevronUp,
  Send,
  Loader2,
  ExternalLink,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useAppAuth } from '@/auth/useAppAuth';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import {
  useGetAutomations,
  useUpdateAutomation,
  useTestAutomation,
} from '@/queries/useAutomationsQueries';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface AutomationConfig {
  enabled: boolean;
  subject: string;
  body: string;
  recipients: string;
}

const AUTOMATION_DEFINITIONS = [
  {
    type: 'bookingConfirmation',
    title: 'Booking Confirmation',
    description: 'Send an email to the customer after a successful appointment booking.',
    variables: ['{{customer_name}}', '{{booking_date}}', '{{booking_time}}', '{{event_type}}'],
  },
  {
    type: 'newLeadAlert',
    title: 'New Lead Alert',
    description: 'Notify your team when a new lead is captured via the chatbot.',
    variables: ['{{lead_name}}', '{{lead_email}}', '{{lead_phone}}', '{{conversation_summary}}'],
  },
  {
    type: 'conversationSummary',
    title: 'Conversation Summary',
    description: 'Send a summary of each conversation to the team inbox at the end of a session.',
    variables: ['{{customer_name}}', '{{summary}}', '{{sentiment}}', '{{duration}}'],
  },
  {
    type: 'followUp',
    title: 'Follow-Up',
    description: 'Automatically follow up with customers who did not complete a booking.',
    variables: ['{{customer_name}}', '{{chat_date}}', '{{booking_link}}'],
  },
] as const;

const defaultConfig = (): AutomationConfig => ({
  enabled: false,
  subject: '',
  body: '',
  recipients: '',
});

function AutomationCard({
  definition,
  serverData,
  isAdmin,
}: {
  definition: (typeof AUTOMATION_DEFINITIONS)[number];
  serverData: Any;
  isAdmin: boolean;
}) {
  const updateAutomation = useUpdateAutomation();
  const testAutomation = useTestAutomation();

  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<AutomationConfig>(defaultConfig());

  useEffect(() => {
    if (serverData) {
      setConfig({
        enabled: serverData.enabled ?? false,
        subject: serverData.subject ?? '',
        body: serverData.body ?? '',
        recipients: serverData.recipients ?? '',
      });
    }
  }, [serverData]);

  const handleToggle = (enabled: boolean) => {
    if (!isAdmin) return;
    setConfig((p) => ({ ...p, enabled }));
    updateAutomation.mutate({ type: definition.type, data: { ...config, enabled } });
  };

  const handleSave = () => {
    updateAutomation.mutate({ type: definition.type, data: config });
  };

  const handleTest = () => {
    testAutomation.mutate({ type: definition.type });
  };

  const insertVariable = (variable: string, field: 'subject' | 'body') => {
    setConfig((p) => ({ ...p, [field]: p[field] + variable }));
  };

  return (
    <Card variant="glass">
      <CardContent className="py-4">
        {/* Top row */}
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600/10 mt-0.5">
            <Mail className="h-4 w-4 text-primary-400" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-text-primary">{definition.title}</p>
              {config.enabled && <Badge variant="success">ON</Badge>}
            </div>
            <p className="text-xs text-text-secondary mt-0.5">{definition.description}</p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {config.enabled && isAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={testAutomation.isPending}
                className="gap-1.5 text-xs"
              >
                {testAutomation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                Test
              </Button>
            )}
            <Switch
              checked={config.enabled}
              onCheckedChange={handleToggle}
              disabled={!isAdmin || updateAutomation.isPending}
            />
            <button
              onClick={() => setExpanded((v) => !v)}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              {expanded ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Expandable config */}
        {expanded && (
          <div className="mt-4 space-y-4 pt-4 border-t border-edge">
            {/* Subject */}
            <div className="space-y-1.5">
              <Label htmlFor={`${definition.type}-subject`}>Subject</Label>
              <Input
                id={`${definition.type}-subject`}
                value={config.subject}
                onChange={(e) => setConfig((p) => ({ ...p, subject: e.target.value }))}
                placeholder="Email subject line..."
                disabled={!isAdmin}
              />
              <div className="flex flex-wrap gap-1 mt-1">
                {definition.variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v, 'subject')}
                    className="rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                    disabled={!isAdmin}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <Label htmlFor={`${definition.type}-body`}>Body</Label>
              <Textarea
                id={`${definition.type}-body`}
                value={config.body}
                onChange={(e) => setConfig((p) => ({ ...p, body: e.target.value }))}
                placeholder="Email body content..."
                rows={5}
                disabled={!isAdmin}
              />
              <div className="flex flex-wrap gap-1 mt-1">
                {definition.variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v, 'body')}
                    className="rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                    disabled={!isAdmin}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Recipients (team notifications) */}
            <div className="space-y-1.5">
              <Label htmlFor={`${definition.type}-recipients`}>
                Recipients
                <span className="ml-1 text-xs text-text-muted font-normal">(comma-separated emails)</span>
              </Label>
              <Input
                id={`${definition.type}-recipients`}
                value={config.recipients}
                onChange={(e) => setConfig((p) => ({ ...p, recipients: e.target.value }))}
                placeholder="team@example.com, manager@example.com"
                disabled={!isAdmin}
              />
            </div>

            {isAdmin && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateAutomation.isPending}
                >
                  {updateAutomation.isPending ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Saving...
                    </span>
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const AutomationsSettings: React.FC = () => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');

  const { data: automationsData, isLoading, error } = useGetAutomations();

  const automations: Any = (automationsData as Any)?.automations ?? {};

  if (isLoading) return <PageSkeleton variant="list" rows={4} />;

  return (
    <div className="space-y-8">
      {/* Email Automations */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Mail className="w-5 h-5 text-primary-400" />
            Email Automations
          </h2>
          <p className="text-sm text-text-secondary mt-0.5">
            Configure automated emails triggered by chatbot events.
          </p>
        </div>

        {error && (
          <InlineError message="Failed to load automations. Please refresh the page." />
        )}

        <div className="space-y-3">
          {AUTOMATION_DEFINITIONS.map((def) => (
            <AutomationCard
              key={def.type}
              definition={def}
              serverData={automations[def.type] ?? null}
              isAdmin={isAdmin}
            />
          ))}
        </div>
      </div>

      {/* CRM Integrations */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">CRM Integrations</h2>
          <p className="text-sm text-text-secondary mt-0.5">
            Sync leads and conversations with your CRM.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { name: 'GoHighLevel', description: 'Sync contacts and conversations to GHL.' },
            { name: 'HubSpot', description: 'Push leads and deals to HubSpot CRM.' },
          ].map((crm) => (
            <Card key={crm.name} variant="glass">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-text-primary">{crm.name}</p>
                    <p className="text-xs text-text-secondary mt-0.5">{crm.description}</p>
                  </div>
                  <Badge variant="warning" className="shrink-0">
                    <Clock className="w-3 h-3 mr-1" />
                    Coming Soon
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Advanced / Webhooks */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Advanced</h2>
          <p className="text-sm text-text-secondary mt-0.5">
            For custom integrations, use webhooks to receive real-time events.
          </p>
        </div>

        <Card variant="glass">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text-primary">Webhook Configuration</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Send chatbot events to your own endpoint in real-time.
                </p>
              </div>
              <a
                href="/settings/integrations"
                className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300 transition-colors"
              >
                Configure
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AutomationsSettings;
