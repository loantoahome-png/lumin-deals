'use client'

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { mergeAdjacentLists } from '@/lib/htmlLists'
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

// Indentable block types and the size of one step.
const INDENTABLE = ['paragraph', 'heading'] as const
const INDENT_STEP_PX = 32
const MAX_INDENT = 10

/**
 * Nudge the indent of every paragraph/heading touched by the selection.
 *
 * ⚠️ This is the half that was missing, and it's the half that matters most
 *    here: the pasted document is mostly PARAGRAPHS ("8/6 Appraisal in for:",
 *    "Requested 8/10", the title lines), not list items. An earlier version
 *    handled only lists and silently did nothing everywhere else, which is
 *    indistinguishable from "Tab is broken".
 */
function shiftIndent(editor: Editor, delta: number): boolean {
  const { state } = editor
  const { from, to } = state.selection
  const tr = state.tr
  let changed = false

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!(INDENTABLE as readonly string[]).includes(node.type.name)) return
    const cur = Number(node.attrs.indent) || 0
    const next = Math.max(0, Math.min(MAX_INDENT, cur + delta))
    if (next === cur) return
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
    changed = true
  })

  if (changed) editor.view.dispatch(tr)
  // TRUE either way — see the note on the extension. Returning false when
  // already at indent 0 would hand Tab back to the browser and let focus
  // escape, which is the original bug.
  return true
}

// ── Tab = indent ────────────────────────────────────────────────────────────
// Efrain 2026-08-10: "I'm trying to indent a line but when I press tab it gets
// out of the editing pane." Then, after a lists-only first attempt: "the tab
// function is still not working."
//
// Tab's browser default is move-focus, which in a document editor means the
// cursor leaves mid-sentence. Two separate things have to work:
//
//   LIST ITEM  → nest under the item above (sinkListItem).
//   PARAGRAPH  → an `indent` attribute rendered as margin-left. There is no
//                built-in indent in this schema, so it's added below.
//
// ⚠️ Every shortcut returns TRUE even when nothing changed. Returning false
//    hands the key back to the browser — the exact focus-escape being fixed.
//
// ⚠️ Consequence, stated not discovered: Tab no longer tabs OUT of the editor.
//    Leave it with Escape or a click. Same trade Google Docs makes.
const TabIndent = Extension.create({
  name: 'tabIndent',

  // The indent lives on the node so it survives save → reload as real HTML
  // (`style="margin-left: 32px"`), rather than as invisible whitespace.
  addGlobalAttributes() {
    return [{
      types: [...INDENTABLE],
      attributes: {
        indent: {
          default: 0,
          parseHTML: (el: HTMLElement) => {
            const px = parseInt(el.style.marginLeft || '0', 10)
            if (!Number.isFinite(px) || px <= 0) return 0
            return Math.min(Math.round(px / INDENT_STEP_PX), MAX_INDENT)
          },
          renderHTML: (attrs: Record<string, unknown>) => {
            const n = Number(attrs.indent) || 0
            return n > 0 ? { style: `margin-left: ${n * INDENT_STEP_PX}px` } : {}
          },
        },
      },
    }]
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        // A list item nests under the one above it — but only if there IS one
        // above it. Google Docs pastes each item as its own list, which is why
        // lib/htmlLists.ts merges them on load; without that this always fails.
        if (this.editor.can().sinkListItem('listItem')) {
          return this.editor.commands.sinkListItem('listItem')
        }
        return shiftIndent(this.editor, +1)
      },
      'Shift-Tab': () => {
        if (this.editor.can().liftListItem('listItem')) {
          return this.editor.commands.liftListItem('listItem')
        }
        return shiftIndent(this.editor, -1)
      },
    }
  },
})

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
      // ⚠️ AFTER StarterKit on purpose. Later extensions win on conflicting
      //    keyboard shortcuts, and StarterKit's list extensions bind Tab
      //    themselves — put this first and it gets overridden silently.
      TabIndent,
    ],
    // ⚠️ Normalised on the way IN. Google Docs pastes each list item as its own
    //    <ol>, which makes Tab a no-op (nothing above to nest under) and
    //    restarts numbering at 1 on every line. Merging adjacent same-type
    //    lists is what makes the Tab binding above actually do something.
    //    See lib/htmlLists.ts — it deliberately won't merge across a paragraph.
    content: mergeAdjacentLists(initialHtml || ''),
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
