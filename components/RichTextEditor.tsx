'use client'

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, AlignLeft, AlignCenter, AlignRight,
  Link as LinkIcon, Image as ImageIcon, Heading1, Heading2, Heading3,
  Highlighter, RemoveFormatting,
} from 'lucide-react'

// Email-grade rich-text editor (TipTap v3). Stores/returns HTML via onChange.
// StarterKit v3 already bundles bold/italic/underline/strike, headings,
// bullet+ordered lists, and links; the rest come from the extra extensions.

const FONTS = ['Default', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana']
const SIZES = ['12', '14', '16', '18', '20', '24', '30']

export default function RichTextEditor({
  initialHtml,
  onChange,
  autofocus = false,
}: {
  initialHtml: string
  onChange: (html: string) => void
  autofocus?: boolean
}) {
  const editor = useEditor({
    immediatelyRender: false,                 // required for Next.js SSR
    autofocus: autofocus ? 'end' : false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TextStyleKit,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight,
      Image,
    ],
    content: initialHtml || '',
    editorProps: { attributes: { class: 'note-prose min-h-[36vh] focus:outline-none' } },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  })

  if (!editor) return null

  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar editor={editor} />
      <EditorContent
        editor={editor}
        className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-200 p-3 focus-within:ring-2 focus-within:ring-blue-400"
      />
    </div>
  )
}

function Btn({
  on, active, disabled, title, children,
}: {
  on: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}   // keep the editor selection
      onClick={on}
      disabled={disabled}
      title={title}
      className={`h-8 min-w-8 px-1.5 flex items-center justify-center rounded text-slate-600 hover:bg-slate-200/70 disabled:opacity-30 transition-colors ${active ? 'bg-blue-100 text-blue-700' : ''}`}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const sep = <span className="w-px h-5 bg-slate-200 mx-0.5" />

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL', prev ?? 'https://')
    if (url === null) return
    if (url.trim() === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run()
  }
  const addImage = () => {
    const url = window.prompt('Image URL')
    if (url && url.trim()) editor.chain().focus().setImage({ src: url.trim() }).run()
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 p-1.5 mb-2 border border-slate-200 rounded-lg bg-slate-50">
      <select
        title="Font"
        defaultValue="Default"
        onChange={e => {
          const v = e.target.value
          if (v === 'Default') editor.chain().focus().unsetFontFamily().run()
          else editor.chain().focus().setFontFamily(v).run()
        }}
        className="h-8 text-xs border border-slate-200 rounded px-1 bg-white"
      >
        {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
      <select
        title="Font size"
        defaultValue="16"
        onChange={e => editor.chain().focus().setFontSize(`${e.target.value}px`).run()}
        className="h-8 w-14 text-xs border border-slate-200 rounded px-1 bg-white"
      >
        {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      {sep}
      <Btn on={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold"><Bold className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic"><Italic className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline"><UnderlineIcon className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough"><Strikethrough className="w-4 h-4" /></Btn>
      <input
        type="color"
        title="Text color"
        onChange={e => editor.chain().focus().setColor(e.target.value).run()}
        className="h-8 w-8 p-0.5 rounded border border-slate-200 bg-white cursor-pointer"
      />
      <Btn on={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} title="Highlight"><Highlighter className="w-4 h-4" /></Btn>
      {sep}
      <Btn on={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1"><Heading1 className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2"><Heading2 className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3"><Heading3 className="w-4 h-4" /></Btn>
      {sep}
      <Btn on={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet list"><List className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Numbered list"><ListOrdered className="w-4 h-4" /></Btn>
      {sep}
      <Btn on={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} title="Align left"><AlignLeft className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} title="Align center"><AlignCenter className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} title="Align right"><AlignRight className="w-4 h-4" /></Btn>
      {sep}
      <Btn on={setLink} active={editor.isActive('link')} title="Link"><LinkIcon className="w-4 h-4" /></Btn>
      <Btn on={addImage} title="Image"><ImageIcon className="w-4 h-4" /></Btn>
      <Btn on={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} title="Clear formatting"><RemoveFormatting className="w-4 h-4" /></Btn>
    </div>
  )
}
