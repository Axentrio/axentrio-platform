/**
 * Manual lead entry + CSV import.
 *
 * Two things this UI must not do:
 *   - hide a MERGE. If a manual entry or an imported row lands on a contact you already
 *     have, the count won't match what you submitted; saying so is the difference
 *     between "it worked" and "did it lose my data?"
 *   - import blindly. The preview step exists so the operator confirms the merge count
 *     BEFORE anything is written.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/services/apiClient';
import { queryKeys } from '@/queries/queryKeys';

interface ImportPreview {
  totalRows: number;
  create: number;
  merge: number;
  reject: number;
  truncated: boolean;
  rows: Array<{ line: number; reason?: string; outcome: string }>;
}

export const AddLeadControls: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.leads.all() });

  const addLead = useMutation({
    mutationFn: () => api.post<{ id: string; created: boolean }>('/leads', form),
    onSuccess: (res) => {
      // A merge is not a failure, but it is not what they typed either.
      toast.success(
        res.created
          ? t('leads.add.created', { defaultValue: 'Lead added' })
          : t('leads.add.merged', {
              defaultValue: 'We already had this contact — your notes were added to them.',
            }),
      );
      setAddOpen(false);
      setForm({ name: '', email: '', phone: '', notes: '' });
      void refresh();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? t('leads.add.error', { defaultValue: 'Could not add the lead' });
      toast.error(msg);
    },
  });

  const runPreview = useMutation({
    mutationFn: (text: string) => api.post<ImportPreview>('/leads/import/preview', { csv: text }),
    onSuccess: (res) => setPreview(res),
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? t('leads.import.error', { defaultValue: 'Could not read that file' });
      toast.error(msg);
      setCsv(null);
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ created: number; merged: number; rejected: number; failedLines: number[] }>(
        '/leads/import/commit',
        { csv },
      ),
    onSuccess: (res) => {
      toast.success(
        t('leads.import.done', {
          defaultValue: '{{created}} added, {{merged}} merged into existing leads.',
          created: res.created,
          merged: res.merged,
        }),
      );
      setCsv(null);
      setPreview(null);
      void refresh();
    },
    onError: () => toast.error(t('leads.import.error', { defaultValue: 'Import failed' })),
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    runPreview.mutate(text);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t('leads.add.button', { defaultValue: 'Add lead' })}
      </Button>
      <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        {t('leads.import.button', { defaultValue: 'Import CSV' })}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('leads.import.button', { defaultValue: 'Import CSV' })}
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = ''; // allow re-picking the same file after a fix
        }}
      />

      {/* Manual entry */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('leads.add.title', { defaultValue: 'Add a lead' })}</DialogTitle>
            <DialogDescription>
              {t('leads.add.body', {
                defaultValue:
                  'For a customer who called or walked in. An email or phone number is required — it is how we recognise them if they contact you again.',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {(['name', 'email', 'phone', 'notes'] as const).map((field) => (
              <Input
                key={field}
                value={form[field]}
                placeholder={t(`leads.add.${field}`, {
                  defaultValue:
                    field === 'name' ? 'Name' : field === 'email' ? 'Email' : field === 'phone' ? 'Phone' : 'What do they need?',
                })}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
              />
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              disabled={addLead.isPending || (!form.email.trim() && !form.phone.trim())}
              onClick={() => addLead.mutate()}
            >
              {addLead.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('leads.add.save', { defaultValue: 'Add lead' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import preview — nothing is written until this is confirmed */}
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
            setCsv(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('leads.import.title', { defaultValue: 'Import leads' })}</DialogTitle>
            <DialogDescription>
              {t('leads.import.summary', {
                defaultValue:
                  '{{total}} rows: {{create}} new, {{merge}} will be added to contacts you already have, {{reject}} skipped.',
                total: preview?.totalRows ?? 0,
                create: preview?.create ?? 0,
                merge: preview?.merge ?? 0,
                reject: preview?.reject ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>

          {preview && preview.reject > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-edge p-2 text-xs">
              {/* Named lines, so the file can actually be fixed. */}
              {preview.rows
                .filter((r) => r.outcome === 'reject')
                .slice(0, 20)
                .map((r) => (
                  <div key={r.line} className="text-text-muted">
                    {t('leads.import.rejectedRow', {
                      defaultValue: 'Line {{line}} skipped — {{reason}}',
                      line: r.line,
                      reason: r.reason ?? '',
                    })}
                  </div>
                ))}
            </div>
          )}
          {preview?.truncated && (
            <p className="text-xs text-status-away">
              {t('leads.import.truncated', {
                defaultValue: 'Only the first rows of this file will be imported.',
              })}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setPreview(null); setCsv(null); }}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              disabled={commit.isPending || !preview || preview.create + preview.merge === 0}
              onClick={() => commit.mutate()}
            >
              {commit.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('leads.import.confirm', { defaultValue: 'Import' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
