/**
 * Client-side first step — the Clerk organization the wizard runs against.
 *
 * The server cannot see a workspace that does not exist yet, so this step talks
 * to Clerk only: accept an invitation, open a membership, or create a new one.
 * After setActive the shell's useOrganization() reports the org and the rest of
 * the wizard continues without a reload.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganizationList } from '@clerk/clerk-react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageSkeleton } from '@/components/ui/page-skeleton';

function clerkErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const record = err as {
    errors?: Array<{ longMessage?: string; message?: string }>;
    message?: string;
  };
  return (
    record.errors?.[0]?.longMessage ||
    record.errors?.[0]?.message ||
    record.message ||
    fallback
  );
}

function OrgTile({
  name,
  imageUrl,
  hasImage,
}: {
  name: string;
  imageUrl?: string;
  hasImage?: boolean;
}) {
  if (hasImage && imageUrl) {
    return (
      <img src={imageUrl} alt={name} className="h-7 w-7 rounded-lg object-cover" />
    );
  }
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-600">
      <span className="text-xs font-bold text-white">
        {name.charAt(0)?.toUpperCase() ?? 'A'}
      </span>
    </div>
  );
}

export function WorkspaceStep() {
  const { t } = useTranslation();
  const { isLoaded, userMemberships, userInvitations, createOrganization, setActive } =
    useOrganizationList({
      userMemberships: { infinite: true },
      userInvitations: { infinite: true },
    });
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (
    !isLoaded ||
    !createOrganization ||
    !setActive ||
    userMemberships.isLoading ||
    userInvitations.isLoading
  ) {
    return <PageSkeleton variant="list" rows={3} />;
  }

  const invitations = userInvitations.data ?? [];
  const memberships = userMemberships.data ?? [];
  const fallback = t('setup.steps.workspace.error');

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(clerkErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const acceptInvitation = (invitation: (typeof invitations)[number]) =>
    run(async () => {
      await invitation.accept();
      await setActive({ organization: invitation.publicOrganizationData.id });
    });

  const openMembership = (organizationId: string) =>
    run(async () => {
      await setActive({ organization: organizationId });
    });

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      const org = await createOrganization({ name: trimmed });
      await setActive({ organization: org.id });
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">
          {t('setup.steps.workspace.title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.workspace.body')}</p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {invitations.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('setup.steps.workspace.invitations')}
          </h3>
          <ul className="space-y-2">
            {invitations.map((invitation) => {
              const org = invitation.publicOrganizationData;
              return (
                <li
                  key={invitation.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-surface-2 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <OrgTile
                      name={org.name}
                      imageUrl={org.imageUrl}
                      hasImage={org.hasImage}
                    />
                    <span className="truncate text-sm font-medium text-text-primary">
                      {org.name}
                    </span>
                  </div>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void acceptInvitation(invitation)}
                  >
                    {t('setup.steps.workspace.accept')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {memberships.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('setup.steps.workspace.memberships')}
          </h3>
          <ul className="space-y-2">
            {memberships.map((membership) => {
              const org = membership.organization;
              return (
                <li
                  key={membership.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-surface-2 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <OrgTile
                      name={org.name}
                      imageUrl={org.imageUrl}
                      hasImage={org.hasImage}
                    />
                    <span className="truncate text-sm font-medium text-text-primary">
                      {org.name}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void openMembership(org.id)}
                  >
                    {t('setup.steps.workspace.open')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-primary">
          {t('setup.steps.workspace.createTitle')}
        </h3>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('setup.steps.workspace.namePlaceholder')}
            autoComplete="organization"
          />
          <Button type="submit" disabled={busy || name.trim() === ''}>
            {t('setup.steps.workspace.create')}
          </Button>
        </form>
      </section>
    </div>
  );
}
