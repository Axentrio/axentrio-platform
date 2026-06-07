/**
 * Entry Point
 * React application bootstrap
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initSentry } from './config/sentry';

// Styles
import './styles/index.css';

// i18n — must be imported before any component that uses translations
import './i18n';

// Error tracking — no-op unless VITE_SENTRY_DSN is set
initSentry();

// Initialize React
const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
