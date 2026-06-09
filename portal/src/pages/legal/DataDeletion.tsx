/**
 * Data Deletion Instructions (public).
 * Satisfies Meta's "Data Deletion Instructions URL" requirement
 * (App Dashboard → Settings → Basic → https://app.axentrio.com/data-deletion).
 */

import React from 'react';
import LegalLayout, { LegalSection } from './LegalLayout';

const DataDeletion: React.FC = () => {
  return (
    <LegalLayout title="Data Deletion Instructions" lastUpdated="June 9, 2026">
      <p>
        Axentrio respects your right to delete your data. This page explains how to
        request deletion of the information we hold about you, whether you are a
        business that uses Axentrio (a &ldquo;Customer&rdquo;) or someone who messaged
        a business through a channel connected to Axentrio (an &ldquo;End User&rdquo;).
      </p>

      <LegalSection heading="What data this covers">
        <p>
          A deletion request covers the personal information associated with you in
          the Service, including account details, connected channel identifiers, and
          the conversation messages and contact details exchanged with the AI
          assistant.
        </p>
      </LegalSection>

      <LegalSection heading="How to request deletion">
        <ol className="list-decimal space-y-2 pl-6">
          <li>
            Send an email to{' '}
            <a href="mailto:privacy@axentrio.com" className="text-primary-600 underline">
              privacy@axentrio.com
            </a>{' '}
            with the subject line <strong>&ldquo;Data Deletion Request&rdquo;</strong>.
          </li>
          <li>
            Tell us how you used the Service so we can locate your data — for example,
            the Facebook Page, Instagram account, or WhatsApp number you messaged, and
            the name or contact details you used in the conversation.
          </li>
          <li>
            So we can verify the request, send it from the email address associated
            with your account, or include enough detail for us to confirm the data
            belongs to you.
          </li>
        </ol>
      </LegalSection>

      <LegalSection heading="What happens next">
        <p>
          We will confirm receipt of your request and delete or de-identify the
          associated personal information within 30 days, except where we are required
          to retain it to comply with a legal obligation, resolve disputes, or enforce
          our agreements. If you contacted a business through a connected channel, that
          business is the controller of your data; we will action your request and, where
          appropriate, coordinate with that business.
        </p>
      </LegalSection>

      <LegalSection heading="Removing a connected channel">
        <p>
          Customers can also disconnect a Facebook Page, Instagram account, or WhatsApp
          number at any time from the Channels section of the Axentrio dashboard.
          Disconnecting revokes Axentrio&rsquo;s access tokens for that channel and
          stops further message processing. To also delete the historical data for that
          channel, submit a deletion request as described above.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about deletion? Email{' '}
          <a href="mailto:privacy@axentrio.com" className="text-primary-600 underline">
            privacy@axentrio.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
};

export default DataDeletion;
