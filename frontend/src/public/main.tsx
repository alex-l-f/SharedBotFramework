// Entry of the standalone chat page (chat.html, served at /c/<token>): its
// own small bundle, with none of the management app.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installScormShim } from '../lib/scorm';
import { PublicChat } from './PublicChat';
import './public.css';

// Must exist on the top window before any course page loads in the viewer.
installScormShim();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PublicChat />
  </StrictMode>,
);
