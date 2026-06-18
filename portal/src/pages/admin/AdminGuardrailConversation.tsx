/**
 * Super-admin incident-response view (#9): look up ONE conversation by id and see its
 * enforcement state + both guardrail journals + handoff state, with a reversible
 * Resume-AI action. Reached from the Guardrails cockpit (flagged feed "Inspect" or the
 * id-lookup box). Backed by GET/POST /admin/guardrails/conversations/:id.
 */
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, ArrowLeft, ExternalLink, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { useGuardrailConversation, useResumeAiAdmin } from '../../queries/useAdminQueries';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';

interface LogRow {
  id: string;
  detectedCategory?: string;
  families?: string[];
  reasons?: string[];
  enforced: boolean;
  sourceChannel?: string;
  createdAt: string;
}

export default function AdminGuardrailConversation() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const { data, isLoading, error } = useGuardrailConversation(conversationId);
  const resumeAi = useResumeAiAdmin();
  const { switchTenant } = useTenantSwitch();

  if (isLoading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin text-text-muted" /></div>;
  if (error || !data?.session) {
    return (
      <div className="p-6 space-y-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/guardrails')} className="gap-1">
          <ArrowLeft className="w-4 h-4" /> {t('admin.incident.back')}
        </Button>
        <p className="text-sm text-text-muted">{t('admin.incident.notFound')}</p>
      </div>
    );
  }

  const s = data.session;
  const paused = s.aiAutoReplyEnabled === false || s.guardrailStatus !== 'normal';
  const inbound = (data.inboundLogs ?? []) as LogRow[];
  const output = (data.outputLogs ?? []) as LogRow[];
  const handoffs = (data.handoffs ?? []) as Array<{ id: string; status: string; reason?: string; createdAt: string }>;

  const logTable = (rows: LogRow[], catOf: (r: LogRow) => string) =>
    rows.length === 0 ? (
      <p className="text-sm text-text-muted">{t('admin.incident.none')}</p>
    ) : (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin.guardrails.col.time')}</TableHead>
            <TableHead>{t('admin.guardrails.col.category')}</TableHead>
            <TableHead>{t('admin.guardrails.col.reasons')}</TableHead>
            <TableHead>{t('admin.guardrails.col.mode')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-xs text-text-muted">{new Date(r.createdAt).toLocaleString()}</TableCell>
              <TableCell>{catOf(r)}</TableCell>
              <TableCell className="max-w-xs truncate text-xs text-text-secondary">{(r.reasons ?? []).join('; ')}</TableCell>
              <TableCell>
                <Badge variant={r.enforced ? 'destructive' : 'secondary'}>
                  {r.enforced ? t('admin.guardrails.enforced') : t('admin.guardrails.shadow')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/guardrails')} className="gap-1">
          <ArrowLeft className="w-4 h-4" /> {t('admin.incident.back')}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => switchTenant({ tenantId: s.tenantId, tenantName: s.tenantId.slice(0, 8) }, `/inbox?chat=${s.id}`)}
          >
            {t('admin.incident.openInbox')} <ExternalLink className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            className="gap-1"
            disabled={!paused || resumeAi.isPending}
            onClick={() => resumeAi.mutate(s.id)}
          >
            <RotateCcw className="w-3.5 h-3.5" /> {t('admin.incident.resumeAi')}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="font-medium">{t('admin.incident.enforcementState')}</CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline">{t('admin.incident.statusLabel')}: {s.status}</Badge>
          <Badge variant={s.guardrailStatus !== 'normal' ? 'destructive' : 'secondary'}>guardrail: {s.guardrailStatus}</Badge>
          <Badge variant={s.aiAutoReplyEnabled ? 'secondary' : 'destructive'}>
            {s.aiAutoReplyEnabled ? t('admin.incident.aiOn') : t('admin.incident.aiPaused')}
          </Badge>
          <Badge variant="outline">{s.channel}</Badge>
          <Badge variant="outline">tenant: {s.tenantId.slice(0, 8)}</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-medium">{t('admin.incident.inboundJournal')}</CardHeader>
        <CardContent>{logTable(inbound, (r) => r.detectedCategory ?? '—')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="font-medium">{t('admin.incident.outputJournal')}</CardHeader>
        <CardContent>{logTable(output, (r) => (r.families ?? []).join(', ') || '—')}</CardContent>
      </Card>

      <Card>
        <CardHeader className="font-medium">{t('admin.incident.handoffs')}</CardHeader>
        <CardContent>
          {handoffs.length === 0 ? (
            <p className="text-sm text-text-muted">{t('admin.incident.none')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {handoffs.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  <Badge variant="outline">{h.status}</Badge>
                  <span className="text-text-secondary">{h.reason ?? ''}</span>
                  <span className="text-xs text-text-muted">{new Date(h.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-text-muted">
        <Link to="/admin/guardrails" className="text-primary-400 hover:text-primary-300">{t('admin.incident.backToCockpit')}</Link>
      </p>
    </div>
  );
}
