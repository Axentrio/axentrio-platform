/**
 * Super-admin Guardrails cockpit.
 * - Per-tenant activity + the enforce toggle (shadow → enforce).
 * - A recency feed of flagged conversations (inbound spam/scam + output checks),
 *   each deep-linking to the inbox conversation.
 * Backed by /admin/guardrails/{summary,flagged} + PUT /admin/tenants/:id/guardrails.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShieldAlert, ExternalLink, Activity, Search } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  useGuardrailSummary,
  useGuardrailFlagged,
  useSetTenantGuardrailEnforce,
  useAdminTenantsAll,
  useObservabilityOverview,
} from '../../queries/useAdminQueries';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';

interface ObsTotals {
  sessions: number;
  messages: number;
  guardrailInbound: { enforced: number; shadow: number };
  guardrailOutput: { enforced: number; shadow: number };
  handoffs: number;
  openHandoffs: number;
  handoffRate: number;
  deliveryFailures: number;
  channelsDown: number;
  enforceOnTenants: number;
  enforcedBlocks: number;
  impliedInboundFp: { enforcedResumed: number; ofEnforcedInbound: number };
}

function Stat({ label, value, sub, alert }: { label: string; value: number; sub?: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-1/40 px-3 py-2">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-xl font-semibold ${alert && value > 0 ? 'text-red-500' : 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-muted">{sub}</p>}
    </div>
  );
}

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
  const { data: obs, isLoading: obsLoading } = useObservabilityOverview(7);
  const setEnforce = useSetTenantGuardrailEnforce();
  const { switchTenant } = useTenantSwitch();
  const navigate = useNavigate();
  const [lookupId, setLookupId] = useState('');
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

      {/* #9 incident lookup: jump to ANY conversation's enforcement state + journals */}
      <form
        className="flex items-center gap-2 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          const id = lookupId.trim();
          if (id) navigate(`/admin/guardrails/${id}`);
        }}
      >
        <Input
          value={lookupId}
          onChange={(e) => setLookupId(e.target.value)}
          placeholder={t('admin.incident.lookupPlaceholder')}
          className="text-sm"
        />
        <Button type="submit" variant="outline" size="sm" className="gap-1 shrink-0" disabled={!lookupId.trim()}>
          <Search className="w-3.5 h-3.5" /> {t('admin.incident.lookup')}
        </Button>
      </form>

      {/* Rollout Health — operational snapshot over existing data (last N days) */}
      <Card>
        <CardHeader className="font-medium flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary-500" />
          {t('admin.observability.title', { days: obs?.windowDays ?? 7 })}
        </CardHeader>
        <CardContent>
          {obsLoading ? (
            <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
          ) : !obs?.totals ? (
            <p className="text-sm text-text-muted">{t('admin.guardrails.empty')}</p>
          ) : (
            (() => {
              const x = obs.totals as ObsTotals;
              const split = (g: { enforced: number; shadow: number }) =>
                t('admin.observability.split', { enforced: g.enforced, shadow: g.shadow });
              return (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                  <Stat label={t('admin.observability.stat.sessions')} value={x.sessions} />
                  <Stat label={t('admin.observability.stat.messages')} value={x.messages} />
                  <Stat
                    label={t('admin.observability.stat.handoffs')}
                    value={x.handoffs}
                    sub={t('admin.observability.openHandoffs', { count: x.openHandoffs })}
                  />
                  <Stat
                    label={t('admin.observability.stat.inboundFlags')}
                    value={x.guardrailInbound.enforced + x.guardrailInbound.shadow}
                    sub={split(x.guardrailInbound)}
                  />
                  <Stat
                    label={t('admin.observability.stat.outputFlags')}
                    value={x.guardrailOutput.enforced + x.guardrailOutput.shadow}
                    sub={split(x.guardrailOutput)}
                  />
                  <Stat label={t('admin.observability.stat.deliveryFailures')} value={x.deliveryFailures} alert />
                  <Stat label={t('admin.observability.stat.channelsDown')} value={x.channelsDown} alert />
                  <Stat
                    label={t('admin.observability.stat.handoffRate')}
                    value={Math.round((x.handoffRate ?? 0) * 100) / 100}
                  />
                  <Stat label={t('admin.observability.stat.enforcedBlocks')} value={x.enforcedBlocks ?? 0} />
                  <Stat
                    label={t('admin.observability.stat.impliedFp')}
                    value={x.impliedInboundFp?.enforcedResumed ?? 0}
                    sub={t('admin.observability.impliedFpSub', { count: x.impliedInboundFp?.ofEnforcedInbound ?? 0 })}
                  />
                </div>
              );
            })()
          )}
          {obs?.totals && (
            <p className="mt-3 text-xs text-text-muted">
              {t('admin.observability.enforcingTenants', { count: (obs.totals as ObsTotals).enforceOnTenants })}
            </p>
          )}
        </CardContent>
      </Card>

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
                    <TableCell className="flex items-center gap-1">
                      {/* #9: incident-response detail (enforcement state + journals + resume) */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-xs text-primary-500"
                        onClick={() => navigate(`/admin/guardrails/${e.conversationId}`)}
                      >
                        {t('admin.incident.inspect')}
                      </Button>
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
