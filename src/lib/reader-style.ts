import type { AnnotationColor } from '@/lib/document-annotations';

// The reading chrome's theme and the CSS both readers share — the PDF book
// (src/components/reader/PdfBook.tsx) and the rendered-document path of the
// document view (src/pages/DocumentReader.tsx). Plain values, kept apart
// from the components in reader-chrome.tsx so fast refresh keeps working.

export type ReaderTheme = 'parchment' | 'dark';

// Inline colored boxes for each annotation rect on a page, and the dot that
// stands for a colour in a list or a menu.
export const ANNOTATION_FILL: Record<AnnotationColor, string> = {
  gold: 'rgba(245, 207, 96, 0.45)',
  green: 'rgba(134, 239, 172, 0.4)',
  pink: 'rgba(244, 114, 182, 0.4)',
  blue: 'rgba(96, 165, 250, 0.4)',
};
export const ANNOTATION_DOT: Record<AnnotationColor, string> = {
  gold: '#f5cf60',
  green: '#86efac',
  pink: '#f472b6',
  blue: '#60a5fa',
};

// The reading pane's scrollbar wears the reader's theme — the app-wide
// white-on-dark bar washes out on parchment. The thumb rides the whole
// case; the step arrows move it a line at a time (hold to crawl).
export function scrollbarCss(theme: ReaderTheme): string {
  const dark = theme === 'dark';
  const sbTrack = dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(42, 30, 16, 0.08)';
  const sbThumb = dark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(42, 30, 16, 0.5)';
  const sbBtnHover = dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(42, 30, 16, 0.16)';
  const sbInk = dark ? 'rgba(255,255,255,0.65)' : 'rgba(42,30,16,0.75)';
  return `
      .reader-scroll::-webkit-scrollbar-track { background: ${sbTrack}; }
      .reader-scroll::-webkit-scrollbar-thumb {
        background: ${sbThumb};
        border-radius: 8px;
        border: 3px solid transparent;
        background-clip: padding-box;
        min-height: 48px;
      }
      .reader-scroll::-webkit-scrollbar-thumb:hover { background: rgba(232, 184, 74, 0.9); background-clip: padding-box; }
      .reader-scroll::-webkit-scrollbar-thumb:active { background: #e8b84a; background-clip: padding-box; }
      .reader-scroll::-webkit-scrollbar-button {
        width: 15px;
        height: 15px;
        background-color: ${sbTrack};
        background-repeat: no-repeat;
        background-position: center;
      }
      .reader-scroll::-webkit-scrollbar-button:hover { background-color: ${sbBtnHover}; }
      .reader-scroll::-webkit-scrollbar-button:vertical:start:increment,
      .reader-scroll::-webkit-scrollbar-button:vertical:end:decrement,
      .reader-scroll::-webkit-scrollbar-button:horizontal:start:increment,
      .reader-scroll::-webkit-scrollbar-button:horizontal:end:decrement { display: none; }
      .reader-scroll::-webkit-scrollbar-button:vertical:decrement { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 1.5 L8 7 L1 7 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:vertical:decrement:hover { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 1.5 L8 7 L1 7 Z' fill='%23e8b84a'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:vertical:increment { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 7.5 L8 2 L1 2 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:vertical:increment:hover { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M4.5 7.5 L8 2 L1 2 Z' fill='%23e8b84a'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:horizontal:decrement { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M1.5 4.5 L7 8 L7 1 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
      .reader-scroll::-webkit-scrollbar-button:horizontal:increment { background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='9'%3E%3Cpath d='M7.5 4.5 L2 8 L2 1 Z' fill='${sbInk}'/%3E%3C/svg%3E"); }
  `;
}

// Printing a rendered document (docx, slides, script): only the document
// itself reaches the paper — no app chrome, no dark ground. PDFs never
// come this way; they print as their original file (and a PDF page has no
// .print-root, so the browser's own Print of it shows nothing — as before).
export const printCss = `
      @media print {
        body * { visibility: hidden !important; }
        .print-root, .print-root * { visibility: visible !important; }
        .print-root {
          position: absolute !important;
          left: 0 !important;
          top: 0 !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          box-shadow: none !important;
        }
      }
`;
