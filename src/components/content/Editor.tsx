// TipTap rich-text editor for Pages. Owns its own editor instance
// and a small toolbar; the parent passes the initial JSON document
// and a save callback that fires on blur.
//
// Backward compat: when the existing content_items have content.body
// stored as a plain string (from the MVP), the parent normalizes it
// to a doc node before passing it in (see normalizeBody below).

import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List as ListIcon,
  ListOrdered,
  Quote,
  Link2,
  Undo2,
  Redo2,
} from 'lucide-react';

interface EditorProps {
  initialContent: object;
  editable: boolean;
  onSave: (json: object) => void;
}

export function RichTextEditor({ initialContent, editable, onSave }: EditorProps) {
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: {},
      }),
      Placeholder.configure({
        placeholder: 'Start writing… use the toolbar or Markdown shortcuts (## heading, * list, > quote)',
        emptyEditorClass:
          'before:content-[attr(data-placeholder)] before:text-white/30 before:absolute before:pointer-events-none',
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: 'text-[#e8b84a] underline underline-offset-2 hover:text-[#f5d565] cursor-pointer',
        },
      }),
    ],
    content: initialContent,
    editable,
    editorProps: {
      attributes: {
        class: 'rich-text',
      },
    },
    onBlur: ({ editor }) => {
      onSaveRef.current(editor.getJSON());
    },
  });

  // Keep editable state in sync when the parent toggles the lock.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  if (!editor) return null;

  return (
    <div>
      {editable && <Toolbar editor={editor} />}
      <div className="mt-4">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

interface ToolbarProps {
  editor: ReturnType<typeof useEditor> & object;
}

function Toolbar({ editor }: ToolbarProps) {
  if (!editor) return null;
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = prompt('URL?', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const buttons = [
    {
      key: 'bold',
      Icon: Bold,
      title: 'Bold (Ctrl+B)',
      isActive: editor.isActive('bold'),
      onClick: () => editor.chain().focus().toggleBold().run(),
    },
    {
      key: 'italic',
      Icon: Italic,
      title: 'Italic (Ctrl+I)',
      isActive: editor.isActive('italic'),
      onClick: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      key: 'strike',
      Icon: Strikethrough,
      title: 'Strikethrough',
      isActive: editor.isActive('strike'),
      onClick: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      key: 'code',
      Icon: Code,
      title: 'Inline code',
      isActive: editor.isActive('code'),
      onClick: () => editor.chain().focus().toggleCode().run(),
    },
    null,
    {
      key: 'h1',
      Icon: Heading1,
      title: 'Heading 1',
      isActive: editor.isActive('heading', { level: 1 }),
      onClick: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      key: 'h2',
      Icon: Heading2,
      title: 'Heading 2',
      isActive: editor.isActive('heading', { level: 2 }),
      onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      key: 'h3',
      Icon: Heading3,
      title: 'Heading 3',
      isActive: editor.isActive('heading', { level: 3 }),
      onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    null,
    {
      key: 'bullet',
      Icon: ListIcon,
      title: 'Bullet list',
      isActive: editor.isActive('bulletList'),
      onClick: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      key: 'ordered',
      Icon: ListOrdered,
      title: 'Numbered list',
      isActive: editor.isActive('orderedList'),
      onClick: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      key: 'quote',
      Icon: Quote,
      title: 'Quote',
      isActive: editor.isActive('blockquote'),
      onClick: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      key: 'codeblock',
      Icon: Code,
      title: 'Code block',
      isActive: editor.isActive('codeBlock'),
      onClick: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    null,
    {
      key: 'link',
      Icon: Link2,
      title: 'Link',
      isActive: editor.isActive('link'),
      onClick: setLink,
    },
    null,
    {
      key: 'undo',
      Icon: Undo2,
      title: 'Undo (Ctrl+Z)',
      isActive: false,
      onClick: () => editor.chain().focus().undo().run(),
    },
    {
      key: 'redo',
      Icon: Redo2,
      title: 'Redo (Ctrl+Shift+Z)',
      isActive: false,
      onClick: () => editor.chain().focus().redo().run(),
    },
  ];

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 px-2 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(20,20,28,0.8)] backdrop-blur-[10px]">
      {buttons.map((b, i) =>
        b === null ? (
          <span key={`sep-${i}`} className="w-px h-5 bg-[rgba(255,255,255,0.08)] mx-1" />
        ) : (
          <button
            key={b.key}
            type="button"
            title={b.title}
            onClick={b.onClick}
            className={`p-1.5 rounded transition-colors ${
              b.isActive
                ? 'bg-[#e8b84a]/20 text-[#e8b84a]'
                : 'text-white/60 hover:bg-[rgba(255,255,255,0.06)] hover:text-white'
            }`}
          >
            <b.Icon size={14} strokeWidth={2} />
          </button>
        )
      )}
    </div>
  );
}


// Convert legacy/missing body shapes into the TipTap JSON doc shape.
// MVP stored content.body as a plain string; TipTap expects a doc node.
export function normalizeBody(raw: unknown): object {
  if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'doc') {
    return raw as object;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    // Split on blank lines into paragraphs; preserve single newlines as
    // hard breaks within a paragraph.
    const paragraphs = raw.split(/\n\s*\n/);
    return {
      type: 'doc',
      content: paragraphs.map((p) => {
        const lines = p.split('\n');
        const inline: object[] = [];
        lines.forEach((line, idx) => {
          if (idx > 0) inline.push({ type: 'hardBreak' });
          if (line.length > 0) inline.push({ type: 'text', text: line });
        });
        return inline.length > 0
          ? { type: 'paragraph', content: inline }
          : { type: 'paragraph' };
      }),
    };
  }
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
