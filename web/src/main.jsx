import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled with the lab (the page loads nothing from outside it): Montserrat for text, IBM Plex Mono for code.
import '@fontsource/montserrat/300.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
// The family's shared stylesheet first (tokens, controls, dark mode), then the lab's own layout.
import './standalone-ui.css';
import './top-menu/top-menu.css';
import App from './App.jsx';
import './app.css';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
