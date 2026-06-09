/**
 * LegalLayout
 * Public, unauthenticated chrome for the legal pages (privacy, terms,
 * data deletion). These render OUTSIDE the Clerk auth gate so Meta's
 * crawler and logged-out visitors can reach them. See App.tsx early-return.
 */

import React from 'react';
import { Link } from 'react-router-dom';

interface LegalLayoutProps {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}

const LegalLayout: React.FC<LegalLayoutProps> = ({ title, lastUpdated, children }) => {
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b border-edge">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <a href="https://axentrio.com" className="text-lg font-bold tracking-tight">
            Axentrio
          </a>
          <nav className="flex gap-5 text-sm text-text-secondary">
            <Link to="/privacy" className="hover:text-text-primary">Privacy</Link>
            <Link to="/terms" className="hover:text-text-primary">Terms</Link>
            <Link to="/data-deletion" className="hover:text-text-primary">Data Deletion</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-text-muted">Last updated: {lastUpdated}</p>
        <div className="legal-prose mt-8 space-y-6 text-[15px] leading-relaxed text-text-secondary">
          {children}
        </div>
      </main>

      <footer className="border-t border-edge">
        <div className="mx-auto max-w-3xl px-6 py-6 text-sm text-text-muted">
          © {new Date().getFullYear()} Axentrio. All rights reserved.
        </div>
      </footer>
    </div>
  );
};

/** Section heading used inside legal pages. */
export const LegalSection: React.FC<{ heading: string; children: React.ReactNode }> = ({
  heading,
  children,
}) => (
  <section className="space-y-3">
    <h2 className="text-xl font-semibold text-text-primary">{heading}</h2>
    {children}
  </section>
);

export default LegalLayout;
