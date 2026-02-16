/**
 * Structure Tree Parser — Tagged PDF semantic structure extraction.
 *
 * Uses pdfjs-dist's page.getStructTree() API to extract the document's
 * logical structure (headings, paragraphs, tables, lists, figures, artifacts).
 *
 * When a PDF is "tagged" (has a StructTreeRoot), pdfjs returns a tree of nodes
 * with roles like 'Document', 'Part', 'Sect', 'H1'-'H6', 'P', 'Table', 'TR',
 * 'TD', 'TH', 'L', 'LI', 'Figure', 'Span', 'Artifact', etc.
 *
 * This parser merges per-page trees and provides structural hints that the
 * LayoutAnalyzer can use to improve flow-mode DOCX output.
 */

export interface StructNode {
  role: string;
  lang?: string;
  alt?: string;
  actualText?: string;
  children: StructNode[];
  pageIndex?: number;
}

/**
 * Parse the structure tree for a single page.
 * Returns null if the page has no structure tree.
 */
export async function getPageStructureTree(page: any): Promise<StructNode | null> {
  try {
    const tree = await page.getStructTree();
    if (!tree) return null;
    return convertNode(tree);
  } catch {
    return null;
  }
}

/**
 * Convert a pdfjs structure tree node to our StructNode format.
 */
function convertNode(node: any): StructNode {
  const result: StructNode = {
    role: node.role || node.type || 'unknown',
    children: [],
  };

  if (node.lang) result.lang = node.lang;
  if (node.alt) result.alt = node.alt;
  if (node.actualText) result.actualText = node.actualText;

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === 'object' && (child.role || child.type || child.children)) {
        result.children.push(convertNode(child));
      }
    }
  }

  return result;
}

/**
 * Check if a PDF document has a meaningful structure tree.
 * A "meaningful" tree has more than just a root /Document with /P children —
 * it should have headings, tables, or lists.
 */
export async function hasStructureTree(pdfJsDoc: any): Promise<boolean> {
  try {
    const page = await pdfJsDoc.getPage(1);
    const tree = await page.getStructTree();
    if (!tree || !tree.children || tree.children.length === 0) return false;

    // Check if tree has meaningful structure (not just flat /P paragraphs)
    return hasStructuralDepth(tree, 0);
  } catch {
    return false;
  }
}

/**
 * Check if a structure tree has meaningful depth (headings, tables, lists).
 */
function hasStructuralDepth(node: any, depth: number): boolean {
  if (depth > 10) return false; // prevent infinite recursion

  const role = (node.role || '').toLowerCase();

  // These roles indicate a meaningfully tagged document
  if (/^h[1-6]$/.test(role)) return true;
  if (role === 'table' || role === 'tr' || role === 'td' || role === 'th') return true;
  if (role === 'l' || role === 'li') return true;
  if (role === 'figure') return true;
  if (role === 'toc' || role === 'tocentry') return true;

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === 'object') {
        if (hasStructuralDepth(child, depth + 1)) return true;
      }
    }
  }

  return false;
}

/**
 * Parse structure trees for all pages and merge into a document-level tree.
 *
 * @param pdfJsDoc  The pdfjs PDFDocumentProxy
 * @returns Root StructNode or null if no structure tree exists
 */
export async function parseDocumentStructureTree(
  pdfJsDoc: any,
): Promise<StructNode | null> {
  const numPages = pdfJsDoc.numPages;
  const root: StructNode = {
    role: 'Document',
    children: [],
  };

  let hasAnyStructure = false;

  for (let i = 1; i <= numPages; i++) {
    try {
      const page = await pdfJsDoc.getPage(i);
      const tree = await page.getStructTree();
      if (!tree) continue;

      const node = convertNode(tree);
      node.pageIndex = i - 1;

      // Tag all descendants with their page index
      tagPageIndex(node, i - 1);

      // If the root is just a /Document or /StructTreeRoot, merge its children
      if (node.role === 'Document' || node.role === 'StructTreeRoot' || node.role === 'Root') {
        root.children.push(...node.children);
      } else {
        root.children.push(node);
      }

      hasAnyStructure = true;
    } catch {
      // Skip pages without structure
    }
  }

  return hasAnyStructure ? root : null;
}

/**
 * Recursively tag all nodes in a tree with a page index.
 */
function tagPageIndex(node: StructNode, pageIndex: number): void {
  node.pageIndex = pageIndex;
  for (const child of node.children) {
    tagPageIndex(child, pageIndex);
  }
}

/**
 * Get structure nodes for a specific page.
 * Returns flat list of nodes tagged with the given page index.
 */
export function getPageStructure(tree: StructNode, pageIndex: number): StructNode[] {
  const result: StructNode[] = [];
  collectByPage(tree, pageIndex, result);
  return result;
}

function collectByPage(node: StructNode, pageIndex: number, out: StructNode[]): void {
  if (node.pageIndex === pageIndex) {
    out.push(node);
  }
  for (const child of node.children) {
    collectByPage(child, pageIndex, out);
  }
}

/**
 * Extract heading levels from structure tree roles.
 * Returns a map of role -> heading level (1-6), or undefined for non-headings.
 */
export function getHeadingLevel(role: string): number | undefined {
  const match = /^[Hh](\d)$/.exec(role);
  if (match) {
    const level = parseInt(match[1], 10);
    if (level >= 1 && level <= 6) return level;
  }
  return undefined;
}

/**
 * Check if a role represents an artifact (header, footer, page number, etc.)
 */
export function isArtifactRole(role: string): boolean {
  return role === 'Artifact' || role === 'artifact';
}

/**
 * Check if a role represents a table element (Table, TR, TD, TH).
 */
export function isTableRole(role: string): boolean {
  const r = role.toLowerCase();
  return r === 'table' || r === 'tr' || r === 'td' || r === 'th' || r === 'thead' || r === 'tbody' || r === 'tfoot';
}

/**
 * Check if a role represents a figure/image element.
 */
export function isFigureRole(role: string): boolean {
  const r = role.toLowerCase();
  return r === 'figure' || r === 'image';
}

/**
 * Check if a role represents a list element (L, LI, Lbl, LBody).
 */
export function isListRole(role: string): boolean {
  const r = role.toLowerCase();
  return r === 'l' || r === 'li' || r === 'lbl' || r === 'lbody' || r === 'list';
}

/**
 * Walk a structure tree and collect nodes matching a predicate.
 */
export function walkTree(
  node: StructNode,
  predicate: (n: StructNode) => boolean,
  results: StructNode[] = [],
): StructNode[] {
  if (predicate(node)) results.push(node);
  for (const child of node.children) {
    walkTree(child, predicate, results);
  }
  return results;
}
