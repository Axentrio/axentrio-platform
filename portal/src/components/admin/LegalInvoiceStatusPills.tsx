import { Badge } from '@/components/ui/badge';

function tone(kind: 'ok' | 'warn' | 'bad' | 'muted'): string {
  switch (kind) {
    case 'ok':
      return 'bg-status-online/10 text-status-online border-status-online/20';
    case 'warn':
      return 'bg-accent-500/10 text-accent-400 border-accent-500/20';
    case 'bad':
      return 'bg-status-busy/10 text-status-busy border-status-busy/20';
    default:
      return 'bg-surface-3 text-text-muted border-edge';
  }
}

function paymentTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'paid') return 'ok';
  if (status === 'pending') return 'warn';
  if (status === 'failed') return 'bad';
  return 'muted';
}

function invoiceTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'sent' || status === 'created') return 'ok';
  if (status === 'draft' || status === 'manual_review') return 'warn';
  if (status === 'failed') return 'bad';
  return 'muted';
}

function peppolTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'sent' || status === 'not_required') return 'ok';
  if (status === 'pending' || status === 'not_available') return 'warn';
  if (status === 'failed') return 'bad';
  return 'muted';
}

export function LegalInvoiceStatusPills({
  paymentStatus,
  invoiceStatus,
  peppolStatus,
}: {
  paymentStatus: string;
  invoiceStatus: string;
  peppolStatus: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge className={tone(paymentTone(paymentStatus))}>{paymentStatus}</Badge>
      <Badge className={tone(invoiceTone(invoiceStatus))}>{invoiceStatus}</Badge>
      <Badge className={tone(peppolTone(peppolStatus))}>{peppolStatus}</Badge>
    </div>
  );
}
