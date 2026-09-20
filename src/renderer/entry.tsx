import { createRoot } from 'react-dom/client';
import { App } from '@renderer/windows/chat-window';
import { Settings } from '@renderer/windows/settings-window';
import { History } from '@renderer/windows/history-window';

import { LearningReviewWindow } from '@renderer/windows/learning-review-window';

createRoot(document.getElementById('root')!).render(location.hash === '#learning-review' ? <LearningReviewWindow /> : location.hash === '#settings' ? <Settings /> : location.hash === '#history' ? <History /> : <App />);
