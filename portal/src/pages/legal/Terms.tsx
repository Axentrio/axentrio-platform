/**
 * Terms of Service (public).
 * Linked from the Meta App Dashboard (Settings → Basic → Terms of Service URL →
 * https://app.axentrio.com/terms).
 */

import React from 'react';
import { Link } from 'react-router-dom';
import LegalLayout, { LegalSection } from './LegalLayout';

const Terms: React.FC = () => {
  return (
    <LegalLayout title="Terms of Service" lastUpdated="June 9, 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of
        the Axentrio platform, websites, dashboard, and messaging integrations
        (collectively, the &ldquo;Service&rdquo;). By creating an account or using the
        Service, you agree to these Terms. If you are using the Service on behalf of an
        organization, you represent that you are authorized to bind that organization.
      </p>

      <LegalSection heading="The service">
        <p>
          Axentrio provides an AI customer-engagement platform that lets businesses
          connect an AI assistant to channels such as Facebook Messenger, Instagram,
          WhatsApp, and a website chat widget to answer customer questions, capture
          leads, and schedule bookings.
        </p>
      </LegalSection>

      <LegalSection heading="Accounts and eligibility">
        <p>
          You must provide accurate information when creating an account and keep your
          credentials secure. You are responsible for activity that occurs under your
          account. You must be legally able to enter into these Terms to use the
          Service.
        </p>
      </LegalSection>

      <LegalSection heading="Connected channels">
        <p>
          When you connect a third-party channel (such as a Meta product), you
          authorize Axentrio to access and use that channel to send and receive
          messages on your behalf. Your use of those channels is also subject to the
          terms and policies of the relevant provider, including the Meta Platform
          Terms and Developer Policies. You are responsible for ensuring you have the
          rights and permissions necessary to connect a channel and to message its end
          users.
        </p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <p>You agree not to use the Service to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>violate any law or the rights of others;</li>
          <li>send spam, unsolicited, deceptive, or unlawful messages;</li>
          <li>transmit malware or attempt to disrupt or gain unauthorized access to the Service;</li>
          <li>infringe intellectual property or misuse personal data; or</li>
          <li>violate the policies of any connected messaging platform.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Customer content and data">
        <p>
          You retain ownership of the content and data you and your end users submit
          through the Service. You grant Axentrio the rights necessary to process that
          content to operate and provide the Service. Our handling of personal
          information is described in our{' '}
          <Link to="/privacy" className="text-primary-600 underline">Privacy Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection heading="AI-generated responses">
        <p>
          The Service uses automated and AI-generated responses. While we work to make
          responses helpful and accurate, they may contain errors. You are responsible
          for reviewing and configuring the assistant&rsquo;s behavior for your use case
          and for any commitments made to your end users.
        </p>
      </LegalSection>

      <LegalSection heading="Fees">
        <p>
          Paid plans are billed according to the pricing presented at sign-up or in
          your account. Unless stated otherwise, fees are non-refundable. We may change
          pricing prospectively with notice.
        </p>
      </LegalSection>

      <LegalSection heading="Suspension and termination">
        <p>
          You may stop using the Service at any time. We may suspend or terminate access
          if you violate these Terms or to protect the Service or its users. Upon
          termination, your right to use the Service ends; certain provisions survive as
          needed.
        </p>
      </LegalSection>

      <LegalSection heading="Disclaimers">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;
          without warranties of any kind, whether express or implied, to the maximum
          extent permitted by law.
        </p>
      </LegalSection>

      <LegalSection heading="Limitation of liability">
        <p>
          To the maximum extent permitted by law, Axentrio will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for
          lost profits or data, arising out of or related to your use of the Service.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to these terms">
        <p>
          We may update these Terms from time to time. When we do, we will revise the
          &ldquo;Last updated&rdquo; date above. Continued use of the Service after
          changes take effect constitutes acceptance of the updated Terms.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about these Terms? Email{' '}
          <a href="mailto:support@axentrio.com" className="text-primary-600 underline">
            support@axentrio.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
};

export default Terms;
