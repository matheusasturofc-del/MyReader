import {
  Pen, Pencil, Highlighter, Eraser, Type, MousePointer2, Square, Circle, Minus, MoveUpRight,
  Undo2, Redo2, ZoomIn, ZoomOut, ArrowLeft, Download, Moon, Sun, Upload, FilePlus, Music,
  FileText, BookOpen, FileSpreadsheet, Image, NotebookPen, Trash2, Search, X, Bold, Italic,
  Underline, Strikethrough, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Palette, Play, Pause, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, PanelLeft, Copy,
  Plus, EllipsisVertical, Check, Expand, Shapes, Sparkles, IndentIncrease, IndentDecrease,
  RemoveFormatting, ImagePlus, Printer, FileDown, Contrast, LayoutGrid, Hand, FileMusic,
  Baseline, Save, Library, FolderOpen, Quote, Code, Files, RotateCw, Info, Minimize2, Maximize2,
  FileType, Columns2, BookMarked, StickyNote, Presentation, Ruler, SquareDashed, Move, Scaling,
} from 'lucide';

const ICONS = {
  pen: Pen, pencil: Pencil, highlighter: Highlighter, eraser: Eraser, type: Type,
  pointer: MousePointer2, square: Square, circle: Circle, minus: Minus, arrow: MoveUpRight,
  undo: Undo2, redo: Redo2, 'zoom-in': ZoomIn, 'zoom-out': ZoomOut, back: ArrowLeft,
  download: Download, moon: Moon, sun: Sun, upload: Upload, 'file-plus': FilePlus, music: Music,
  'file-text': FileText, book: BookOpen, sheet: FileSpreadsheet, image: Image, notebook: NotebookPen,
  trash: Trash2, search: Search, x: X, bold: Bold, italic: Italic, underline: Underline,
  strike: Strikethrough, list: List, 'list-ordered': ListOrdered, 'align-left': AlignLeft,
  'align-center': AlignCenter, 'align-right': AlignRight, 'align-justify': AlignJustify,
  palette: Palette, play: Play, pause: Pause, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight, 'chevron-up': ChevronUp, 'chevron-down': ChevronDown,
  sidebar: PanelLeft, copy: Copy, plus: Plus, more: EllipsisVertical, check: Check,
  fit: Expand, shapes: Shapes, sparkles: Sparkles, indent: IndentIncrease, outdent: IndentDecrease,
  'clear-format': RemoveFormatting, 'image-plus': ImagePlus, printer: Printer, 'file-down': FileDown,
  contrast: Contrast, grid: LayoutGrid, hand: Hand, 'file-music': FileMusic, baseline: Baseline,
  save: Save, library: Library, folder: FolderOpen, quote: Quote, code: Code, files: Files,
  rotate: RotateCw, info: Info, minimize: Minimize2, maximize: Maximize2, 'file-type': FileType,
  columns: Columns2, bookmark: BookMarked, sticky: StickyNote, presentation: Presentation,
  ruler: Ruler, margin: SquareDashed, move: Move, scaling: Scaling,
};

function attrs(o) {
  return Object.entries(o)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

/** Retorna o SVG (string) de um ícone Lucide. */
export function icon(name, size = 20, extra = '') {
  const node = ICONS[name];
  if (!node) return '';
  const inner = node.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join('');
  return `<svg class="ic ${extra}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
