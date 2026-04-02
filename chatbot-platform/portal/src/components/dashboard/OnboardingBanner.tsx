import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, Circle, Rocket } from 'lucide-react';
import { useAppAuth } from '../../auth/useAppAuth';
import { useTenantSettings } from '../../queries/useTenantQueries';

interface Step {
  label: string;
  description: string;
  link: string;
  complete: boolean;
}

export const OnboardingBanner: React.FC = () => {
  const { data: tenant, isLoading } = useTenantSettings();
  const { user } = useAppAuth();

  // Only show to admins — agents/supervisors can't configure AI or embed
  if (isLoading || !tenant || (user?.role !== 'admin' && user?.role !== 'super_admin')) return null;

  // tenant data is typed as any — settings.ai and onboarding are not in portal types
  const t = tenant as any;
  const settings = t.settings || {};

  const aiConfigured = !!settings.ai?.enabled && !!settings.ai?.hasApiKey;
  const widgetUsed = !!t.onboarding?.widgetUsed;

  const steps: Step[] = [
    {
      label: 'Set up AI',
      description: 'Configure your AI provider and API key',
      link: '/ai',
      complete: aiConfigured,
    },
    {
      label: 'Go live',
      description: 'Embed the chat widget on your website',
      link: '/settings/widget',
      complete: widgetUsed,
    },
  ];

  const completedCount = steps.filter((s) => s.complete).length;

  // All done — don't render
  if (completedCount === steps.length) return null;

  return (
    <div className="rounded-xl border border-edge bg-surface-3 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-primary-400" />
          <h3 className="text-sm font-semibold text-primary">Get started with HandsOff</h3>
        </div>
        <span className="text-xs text-text-muted">{completedCount}/{steps.length} complete</span>
      </div>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.label} className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {step.complete ? (
                <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
              ) : (
                <Circle className="h-4 w-4 text-text-muted shrink-0" />
              )}
              <div>
                <span className={step.complete ? 'text-sm text-text-muted line-through' : 'text-sm text-primary'}>
                  {step.label}
                </span>
                {!step.complete && (
                  <span className="text-xs text-text-muted ml-2">{step.description}</span>
                )}
              </div>
            </div>
            {!step.complete && (
              <Link
                to={step.link}
                className="text-xs font-medium text-primary-400 hover:text-primary-300"
              >
                Set up →
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
