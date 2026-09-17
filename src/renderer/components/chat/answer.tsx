import { memo, useState, type ComponentProps } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { webLink } from '@shared/answer-actions';
import { CopyButton } from '@renderer/components/chat/copy-button';
import { Copy } from '@renderer/components/ui/icons';

function AnswerLink({ href, children }: ComponentProps<'a'> & ExtraProps) {
  const [failed, setFailed] = useState(false);
  const url = webLink(href);
  if (!url) return <span>{children}</span>;
  return <><a href={url} title={url} onClick={(event) => {
    event.preventDefault();
    setFailed(false);
    void window.moki.openWebLink(url).catch(() => setFailed(true));
  }}>{children}</a>{failed && <span role="status" className="text-[11px] text-ink-3"> Could not open link.</span>}</>;
}

const components: Components = {
  a: AnswerLink,
  img: ({ alt }) => <span className="text-ink-3">[Image: {alt || 'not loaded'}]</span>,
  pre: ({ node, children }) => {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
    // Use the parsed text directly: no DOM text extraction, trimming, or fences.
    const text = code?.type === 'element' ? code.children.map((child) => child.type === 'text' ? child.value : '').join('') : '';
    return <div className="answer-code">
      <div className="flex justify-end border-b border-line px-1 py-0.5"><CopyButton text={text} label="Copy code" /></div>
      <pre>{children}</pre>
    </div>;
  },
  table: ({ children }) => <div className="answer-table"><table>{children}</table></div>,
};

export const Answer = memo(function Answer({ text }: { text: string }) {
  return <div className="answer-shell">
    <div className="answer-markdown text-[13.5px] leading-relaxed text-ink">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => webLink(url) ?? ''}>{text}</Markdown>
    </div>
    <div className="answer-copy mt-2 flex h-7 items-center justify-start"><CopyButton text={text} label="Copy answer" icon={<Copy />} /></div>
  </div>;
});
