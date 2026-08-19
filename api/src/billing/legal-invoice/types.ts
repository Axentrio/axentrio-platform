export type LegalPaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'cancelled';

export type LegalInvoiceStatus =
  | 'draft'
  | 'created'
  | 'sent'
  | 'failed'
  | 'credited'
  | 'manual_review';

export type LegalPeppolStatus =
  | 'not_required'
  | 'pending'
  | 'sent'
  | 'failed'
  | 'not_available';

export type LegalDocumentKind = 'invoice' | 'credit_note';

export type BillingValidationReason =
  | 'missing_company_name'
  | 'missing_vat_number'
  | 'invalid_vat_number'
  | 'incomplete_address'
  | 'missing_country'
  | 'not_b2b';

export interface TenantInvoiceIdentity {
  officialBusinessName: string | null | undefined;
  vatNumber: string | null | undefined;
  vatVerified: boolean;
  invoiceEmail: string | null | undefined;
  invoiceAddress: {
    street?: string | null;
    streetNumber?: string | null;
    boxNumber?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
  } | null | undefined;
  operatingCountry?: string | null;
}

export interface BillingValidationResult {
  ok: boolean;
  reasons: BillingValidationReason[];
  peppolRequired: boolean;
  country: string | null;
  vatNumber: string | null;
  companyName: string | null;
  email: string | null;
  address: {
    street: string;
    streetNumber?: string;
    boxNumber?: string;
    postalCode: string;
    city: string;
    country: string;
  } | null;
}

export interface StripeInvoiceLineLike {
  description?: string | null;
  quantity?: number | null;
  amount?: number | null;
  amount_excluding_tax?: number | null;
  period?: { start?: number | null; end?: number | null } | null;
  taxes?: Array<{
    amount?: number | null;
    tax_rate_details?: { percentage_decimal?: string | null } | null;
  }> | null;
  tax_amounts?: Array<{
    amount?: number | null;
    tax_rate?: { percentage?: number | null } | string | null;
  }> | null;
}

export interface StripeInvoiceLike {
  id: string;
  amount_paid?: number | null;
  total?: number | null;
  total_excluding_tax?: number | null;
  currency?: string | null;
  created?: number | null;
  period_start?: number | null;
  period_end?: number | null;
  status_transitions?: { paid_at?: number | null } | null;
  customer?: string | { id?: string } | null;
  subscription?: string | { id?: string } | null;
  parent?: {
    subscription_details?: { subscription?: string | { id?: string } | null } | null;
  } | null;
  lines?: { data?: StripeInvoiceLineLike[]; has_more?: boolean } | null;
}

export interface BillitOrderLine {
  Quantity: number;
  UnitPriceExcl: number;
  Description: string;
  VATPercentage: number;
  Reference?: string;
}

export interface BillitOrderPayload {
  OrderType: 'Invoice' | 'CreditNote';
  OrderDirection: 'Income';
  OrderNumber: string;
  OrderDate: string;
  ExpiryDate: string;
  Paid: true;
  PaidDate: string;
  Currency: string;
  OrderTitle?: string;
  AboutInvoiceNumber?: string;
  ExternalProviderID: string;
  Customer: {
    Name: string;
    VATNumber: string;
    PartyType: 'Customer';
    Email?: string;
    Nr?: string;
    Addresses: Array<{
      AddressType: 'InvoiceAddress';
      Name: string;
      Street: string;
      StreetNumber?: string;
      Box?: string;
      Zipcode: string;
      City: string;
      CountryCode: string;
    }>;
  };
  OrderLines: BillitOrderLine[];
}

export interface PeppolParticipant {
  registered: boolean;
  documentTypes: string[];
}
