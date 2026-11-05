/**
 * Monaco, set up for a locked-down renderer:
 *  - the core editor plus the lightweight "basic" (Monarch) syntax highlighting for ~80 languages;
 *  - no TypeScript/JSON/CSS language services, so the only worker needed is the generic editor worker, which Vite
 *    bundles as a same-origin file (the CSP allows `worker-src 'self' blob:`).
 */
import 'monaco-editor/esm/vs/editor/edcore.main'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

monaco.editor.defineTheme('studio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0a0c10',
    'editor.foreground': '#e7eaf0',
    'editorLineNumber.foreground': '#5b6475',
    'editorLineNumber.activeForeground': '#8b94a5',
    'editor.lineHighlightBackground': '#151922',
    'editor.selectionBackground': '#7c6cff40',
    'editorCursor.foreground': '#7c6cff',
    'editorWidget.background': '#0f1218',
    'editorWidget.border': '#222835',
    'editorIndentGuide.background1': '#1b202b',
    'scrollbarSlider.background': '#2a304080'
  }
})

export { monaco }
