import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installScormShim } from './lib/scorm';
import '@xyflow/react/dist/style.css';
import './styles.css';

// Must exist on the top window before any course page loads in the viewer.
installScormShim();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
