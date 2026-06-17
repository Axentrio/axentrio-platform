/**
 * Super-admin Guardrails cockpit.
 * - Per-tenant activity + the enforce toggle (shadow → enforce).
 * - A recency feed of flagged conversations (inbound spam/scam + output checks),
 *   each deep-linking to the inbox conversation.
 * Backed by /admin/guardrails/{summary,flagged} + PUT /admin/tenants/:id/guardrails.
 */
import { useTranslation } from 'react-i18next';
import { Loader2, ShieldAlert, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  useGuardrailSummary,
  useGuardrailFlagged,
  useSetTenantGuardrailEnforce,
  useAdminTenantsAll,
} from '../../queries/useAdminQueries';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';

interface TenantRow {
  tenant_id: string;
  tenant_name: string | null;
  enforce_on: boolean;
  n: number;
  enforced: number;
}
interface FlaggedEvent {
  source: 'inbound' | 'output';
  id: string;
  tenantId: string;
  conversationId: string;
  category: string;
  reasons: string[];
  enforced: boolean;
  createdAt: string;
}

export default function AdminGuardrails() {
  const { t } = useTranslation();
  const { data: summary, isLoading: summaryLoading } = useGuardrailSummary(7);
  const { data: events = [], isLoading: feedLoading } = useGuardrailFlagged();
  const setEnforce = useSetTenantGuardrailEnforce();
  const { switchTenant } = useTenantSwitch();
  const { data: tenants = [] } = useAdminTenantsAll({ enabled: true });

  const byTenant: TenantRow[] = summary?.byTenant ?? [];
  const flagged = events as FlaggedEvent[];
  const tenantLabel = (id: string) =>
    (tenants as Array<{ id: string; name?: string }>).find((tt) => tt.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
          <ShieldAlert className="w-6 h-6 text-amber-500" />
          {t('admin.guardrails.title')}
        </h1>
        <p className="text-sm text-text-secondary mt-1">{t('admin.guardrails.subtitle')}</p>
      </header>

      {/* Per-tenant activity + enforce toggle */}
      <Card>
        <CardHeader className="font-medium">
          {t('admin.guardrails.byTenant', { days: summary?.days ?? 7 })}
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
          ) : byTenant.length === 0 ? (
            <p className="text-sm text-text-muted">{t('admin.guardrails.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.guardrails.col.tenant')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.flagged')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.enforcedCount')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.enforce')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byTenant.map((row) => (
                  <TableRow key={row.tenant_id}>
                    <TableCell className="font-medium">{row.tenant_name || row.tenant_id.slice(0, 8)}</TableCell>
                    <TableCell>{row.n}</TableCell>
                    <TableCell>{row.enforced}</TableCell>
                    <TableCell>
                      <Switch
                        checked={row.enforce_on}
                        disabled={setEnforce.isPending}
                        onCheckedChange={(checked) =>
                          setEnforce.mutate({ tenantId: row.tenant_id, enforce: checked })
                        }
                        aria-label={t('admin.guardrails.col.enforce')}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Flagged conversations feed */}
      <Card>
        <CardHeader className="font-medium">{t('admin.guardrails.flaggedFeed')}</CardHeader>
        <CardContent>
          {feedLoading ? (
            <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
          ) : flagged.length === 0 ? (
            <p className="text-sm text-text-muted">{t('admin.guardrails.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.guardrails.col.time')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.tenant')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.source')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.category')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.reasons')}</TableHead>
                  <TableHead>{t('admin.guardrails.col.mode')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flagged.map((e) => (
                  <TableRow key={`${e.source}-${e.id}`}>
                    <TableCell className="whitespace-nowrap text-xs text-text-muted">
                      {new Date(e.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">{tenantLabel(e.tenantId)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{e.source}</Badge>
                    </TableCell>
                    <TableCell>{e.category}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-text-secondary">
                      {(e.reasons ?? []).join('; ')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={e.enforced ? 'destructive' : 'secondary'}>
                        {e.enforced ? t('admin.guardrails.enforced') : t('admin.guardrails.shadow')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* Cross-tenant deep-link: switch the super-admin's tenant
                          context to this event's tenant first, else /chats/:id 404s. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-xs text-primary-500"
                        onClick={() =>
                          switchTenant(
                            { tenantId: e.tenantId, tenantName: tenantLabel(e.tenantId) },
                            `/inbox?chat=${e.conversationId}`,
                          )
                        }
                      >
                        {t('admin.guardrails.view')} <ExternalLink className="w-3 h-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
