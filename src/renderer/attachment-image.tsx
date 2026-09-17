import { useState } from 'react';
import type { Attachment, AttachmentDraft } from '../shared/protocol';
import { attachmentUrl } from '../shared/attachments';
import { Button } from './ui/button';
import { Close } from './ui/icons';

type ImageAttachment = Attachment | AttachmentDraft;

export function AttachmentImage({ attachment, removable, onRemove }: { attachment: ImageAttachment; removable?: boolean; onRemove?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const src = attachmentUrl(attachment.id);
  return <>
    <div className="relative w-fit overflow-hidden rounded-xl border border-line bg-surface-2">
      <button type="button" className="block cursor-zoom-in" aria-label="Open screenshot preview" onClick={() => setExpanded(true)}>
        <img src={src} alt="Captured screen region" className="block max-h-36 max-w-full object-contain" />
      </button>
      {removable && <span className="absolute top-1 right-1"><Button variant="secondary" size="round-sm" aria-label="Remove screenshot" title="Remove screenshot" onClick={onRemove}><Close /></Button></span>}
    </div>
    {expanded && <div role="dialog" aria-label="Screenshot preview" className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5" onClick={() => setExpanded(false)}>
      <img src={src} alt="Captured screen region, enlarged" className="max-h-full max-w-full rounded-xl object-contain shadow-2xl" onClick={(event) => event.stopPropagation()} />
      <span className="absolute top-3 right-3"><Button variant="secondary" size="icon" aria-label="Close screenshot preview" onClick={() => setExpanded(false)}><Close /></Button></span>
    </div>}
  </>;
}
