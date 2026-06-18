/**
 * Privacy Policy (public).
 * Required by Meta App Review and Google OAuth verification; linked from the
 * Meta App Dashboard (Settings → Basic → Privacy Policy URL) and the Google
 * OAuth consent screen → https://app.axentrio.com/privacy.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import LegalLayout, { LegalSection } from './LegalLayout';

const PrivacyPolicy: React.FC = () => {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="June 19, 2026">
      <p>
        This Privacy Policy explains how Axentrio (&ldquo;Axentrio&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses, and protects information
        when you use our AI customer-engagement platform and the related websites,
        dashboard, and messaging integrations (collectively, the
        &ldquo;Service&rdquo;). Axentrio lets businesses connect an AI assistant to
        channels such as Facebook Messenger, Instagram, WhatsApp, and a website chat
        widget to answer customer questions, capture leads, and schedule bookings.
      </p>

      <LegalSection heading="Who this policy is for">
        <p>
          Axentrio is a business-to-business platform. Our direct customers are the
          businesses that sign up to operate an AI assistant (&ldquo;Customers&rdquo;).
          We also process messages and information from the people who contact those
          businesses through a connected channel (&ldquo;End Users&rdquo;). For End
          User data, the Customer is the data controller and Axentrio acts as a
          processor on their behalf.
        </p>
      </LegalSection>

      <LegalSection heading="Information we collect">
        <p>We collect the following categories of information:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account information.</strong> When a Customer creates an account
            we collect name, email address, organization details, and authentication
            identifiers from our identity provider.
          </li>
          <li>
            <strong>Channel and platform data.</strong> When a Customer connects a
            Facebook Page, Instagram account, or WhatsApp number, we receive Page and
            account identifiers, page names and profile images, and access tokens
            needed to send and receive messages on the Customer&rsquo;s behalf.
          </li>
          <li>
            <strong>Conversation data.</strong> Messages exchanged between End Users
            and the AI assistant, including message text, timestamps, sender
            identifiers, and any attachments or contact details the End User chooses
            to provide (for example a name, email, phone number, or address used to
            book an appointment).
          </li>
          <li>
            <strong>Usage and technical data.</strong> Log data, device and browser
            information, and diagnostic information used to operate and secure the
            Service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="How we use information">
        <ul className="list-disc space-y-2 pl-6">
          <li>To deliver the Service: route messages, generate AI responses, capture leads, and create bookings.</li>
          <li>To authenticate Customers and maintain the connection to their messaging channels.</li>
          <li>To operate, secure, troubleshoot, and improve the Service.</li>
          <li>To comply with legal obligations and enforce our terms.</li>
        </ul>
        <p>
          We do not sell personal information, and we do not use the content of End
          User conversations for advertising.
        </p>
      </LegalSection>

      <LegalSection heading="Meta platform data">
        <p>
          When a Customer connects a Meta product (Messenger, Instagram, or
          WhatsApp), Axentrio accesses Meta platform data only to provide the
          messaging features the Customer has enabled. We use this data in accordance
          with the Meta Platform Terms and Developer Policies, request only the
          permissions required to operate, and retain platform data no longer than
          necessary to provide the Service.
        </p>
      </LegalSection>

      <LegalSection heading="Google user data">
        <p>
          When a Customer connects a Google account, Axentrio requests access to
          Google Calendar using the narrowest permissions required to operate
          appointment booking: the ability to view and edit calendar events, and to
          read the list of calendars the Customer is subscribed to. We use this access
          only to create, reschedule, and cancel the appointments the
          Customer&rsquo;s AI assistant schedules, and to let the Customer choose which
          calendar those bookings are written to. We do not request access to read or
          change calendar data beyond what is necessary to manage those bookings.
        </p>
        <p>
          We store the credentials needed to maintain this connection in encrypted
          form and use Google user data solely to provide the booking features the
          Customer has enabled. We do not sell Google user data, we do not use it for
          advertising, and we do not use it to train generalized
          artificial-intelligence or machine-learning models. A Customer can
          disconnect their Google account at any time, which revokes
          Axentrio&rsquo;s access.
        </p>
        <p>
          Axentrio&rsquo;s use and transfer of information received from Google APIs
          to any other application will adhere to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="text-primary-600 underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </LegalSection>

      <LegalSection heading="How we share information">
        <p>We share information only with the following categories of recipients:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Service providers (sub-processors)</strong> that host our
            infrastructure, store data, and provide the large-language-model
            capabilities used to generate AI responses. These providers process data
            only on our instructions and under confidentiality obligations.
          </li>
          <li>
            <strong>Messaging platforms</strong> (such as Meta) to deliver messages
            to and from the connected channels.
          </li>
          <li>
            <strong>Legal and safety</strong> recipients where required by law or to
            protect the rights, safety, and security of users and the Service.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Data retention">
        <p>
          We retain account and conversation data for as long as a Customer&rsquo;s
          account is active or as needed to provide the Service. Customers may request
          deletion of their data, and End Users may request deletion of their data as
          described below. We delete or de-identify data when it is no longer needed,
          subject to legal retention requirements.
        </p>
      </LegalSection>

      <LegalSection heading="Data deletion">
        <p>
          You can request deletion of your data at any time. Full instructions are on
          our <Link to="/data-deletion" className="text-primary-600 underline">Data Deletion</Link>{' '}
          page.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          We use administrative, technical, and organizational measures designed to
          protect information, including encryption of sensitive credentials in
          transit and at rest and access controls limiting who can access data. No
          method of transmission or storage is completely secure, and we cannot
          guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          Depending on your location, you may have rights to access, correct, delete,
          or restrict the processing of your personal information, and to object to
          certain processing. End Users should direct requests to the business they
          contacted; that business may ask us to act on its behalf. You can also
          contact us using the details below and we will route your request
          appropriately.
        </p>
      </LegalSection>

      <LegalSection heading="International transfers">
        <p>
          We may process and store information in countries other than the one in
          which you reside. Where we transfer personal information across borders, we
          take steps to ensure it remains protected consistent with this policy and
          applicable law.
        </p>
      </LegalSection>

      <LegalSection heading="Children's privacy">
        <p>
          The Service is not directed to children, and we do not knowingly collect
          personal information from children. If you believe a child has provided us
          information, please contact us so we can delete it.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. When we do, we will
          revise the &ldquo;Last updated&rdquo; date above. Material changes will be
          communicated through the Service or by other appropriate means.
        </p>
      </LegalSection>

      <LegalSection heading="Contact us">
        <p>
          If you have questions about this Privacy Policy or our data practices,
          contact us at{' '}
          <a href="mailto:privacy@axentrio.com" className="text-primary-600 underline">
            privacy@axentrio.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
};

export default PrivacyPolicy;
