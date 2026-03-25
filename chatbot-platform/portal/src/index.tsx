/**
 * Entry Point
 * React application bootstrap
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Styles
import './styles/index.css';

// Initialize React
const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
