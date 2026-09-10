/**
 * Sub-processors (public).
 *
 * Rendered from the same list the privacy notice uses, so the two cannot disagree.
 * A customer evaluating Axentrio on data protection needs to know who touches their
 * data — "service providers" is not something anyone can assess.
 */
import React from 'react';
import { SUB_PROCESSORS } from '@contracts/sub-processors';
import LegalLayout, { LegalSection } from './LegalLayout';

const SubProcessors: React.FC = () => {
  return (
    <LegalLayout title="Sub-processors" lastUpdated="September 9, 2026">
      <p>
        Axentrio processes personal data on behalf of the businesses that use it. To
        run the Service we use the providers below, each under a written agreement
        that limits them to processing on our instructions.
      </p>

      <LegalSection heading="Current sub-processors">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-edge">
                <th className="py-2 pr-4 font-semibold">Provider</th>
                <th className="py-2 pr-4 font-semibold">What we use it for</th>
                <th className="py-2 font-semibold">What reaches it</th>
              </tr>
            </thead>
            <tbody>
              {SUB_PROCESSORS.map((sp) => (
                <tr key={sp.name} className="border-b border-edge/50 align-top">
                  <td className="py-2 pr-4 font-medium">{sp.name}</td>
                  <td className="py-2 pr-4">{sp.purpose}</td>
                  <td className="py-2">{sp.data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          We will tell Customers before adding a sub-processor that processes their
          end users&rsquo; personal data, so they have a chance to object.
        </p>
      </LegalSection>

      <LegalSection heading="Transfers">
        <p>
          Some of these providers process data outside the EEA. Where they do, the
          transfer is covered by the European Commission&rsquo;s Standard
          Contractual Clauses or an adequacy decision, as recorded in our Data
          Processing Agreement. Ask us for a copy at{' '}
          <a href="mailto:privacy@axentrio.com" className="text-primary-600 underline">
            privacy@axentrio.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
};

export default SubProcessors;
