import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Settings } from './settings';
import { History } from './history';

createRoot(document.getElementById('root')!).render(location.hash === '#settings' ? <Settings /> : location.hash === '#history' ? <History /> : <App />);
