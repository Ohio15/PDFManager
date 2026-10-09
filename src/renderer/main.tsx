import React from 'react';
import ReactDOM from 'react-dom/client';
// Bounds pdf-lib's own object-stream decoding before any document is loaded.
import './utils/boundedDecode';
import App from './App';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
