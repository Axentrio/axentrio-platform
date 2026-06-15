/**
 * ExportMenu — Enterprise CSV export (P3 / ADR-0014 D7). Downloads one of the
 * three datasets via GET /analytics/export, authenticated through the api
 * client (Clerk bearer token). Renders nothing without aiBusinessInsights.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { api } from '@/services/apiClient';
import { useHasFeature } from '@/queries/useEntitlementsQueries';
import type { ExportDataset } from '@contracts/insights';

const DATASETS: ExportDataset[] = ['outcomes-timeseries', 'gaps', 'leads'];

export function ExportMenu() {
  const { t } = useTranslation();
  const enabled = useHasFeature('aiBusinessInsights');
  const [busy, setBusy] = useState<ExportDataset | null>(null);
  if (!enabled) return null;

  const download = async (dataset: ExportDataset) => {
    setBusy(dataset);
    try {
      const blob = await api.get<Blob>(`/analytics/export?dataset=${dataset}&format=csv`, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${dataset}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t('insights.export.error', { defaultValue: 'Export failed' }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy !== null}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
          {t('insights.export.label', { defaultValue: 'Export CSV' })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {DATASETS.map((d) => (
          <DropdownMenuItem key={d} disabled={busy !== null} onSelect={() => download(d)}>
            {t(`insights.export.dataset.${d}`, { defaultValue: d })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
