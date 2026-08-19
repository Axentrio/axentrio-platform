import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import type {
  LegalDocumentKind,
  LegalInvoiceStatus,
  LegalPaymentStatus,
  LegalPeppolStatus,
} from '../../billing/legal-invoice/types';

@Entity('legal_invoices')
@Index('UQ_legal_invoices_stripe_invoice', ['stripeInvoiceId'], {
  unique: true,
  where: `"document_kind" = 'invoice' AND "stripe_invoice_id" IS NOT NULL`,
})
@Index('UQ_legal_invoices_stripe_refund', ['stripeRefundId'], {
  unique: true,
  where: `"stripe_refund_id" IS NOT NULL`,
})
@Index('IDX_legal_invoices_tenant_created', ['tenantId', 'createdAt'])
export class LegalInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ type: 'varchar', length: 16, name: 'document_kind' })
  documentKind!: LegalDocumentKind;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'stripe_invoice_id' })
  stripeInvoiceId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'stripe_refund_id' })
  stripeRefundId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'stripe_customer_id' })
  stripeCustomerId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'stripe_subscription_id' })
  stripeSubscriptionId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'stripe_charge_id' })
  stripeChargeId?: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'credited_from_id' })
  creditedFromId?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'billit_order_id' })
  billitOrderId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'billit_invoice_number' })
  billitInvoiceNumber?: string | null;

  @Column({ type: 'varchar', length: 16, name: 'payment_status' })
  paymentStatus!: LegalPaymentStatus;

  @Column({ type: 'varchar', length: 24, name: 'invoice_status' })
  invoiceStatus!: LegalInvoiceStatus;

  @Column({ type: 'varchar', length: 24, name: 'peppol_status' })
  peppolStatus!: LegalPeppolStatus;

  @Column({ type: 'boolean', default: false, name: 'peppol_required' })
  peppolRequired!: boolean;

  @Column({ type: 'varchar', length: 8, default: 'EUR' })
  currency!: string;

  @Column({ type: 'int', name: 'amount_excl_cents', default: 0 })
  amountExclCents!: number;

  @Column({ type: 'int', name: 'vat_amount_cents', default: 0 })
  vatAmountCents!: number;

  @Column({ type: 'int', name: 'amount_incl_cents', default: 0 })
  amountInclCents!: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb", name: 'review_reasons' })
  reviewReasons!: string[];

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError?: string | null;

  @Column({ type: 'int', default: 0, name: 'retry_count' })
  retryCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
