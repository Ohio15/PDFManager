/**
 * useFinalizeActions — Flatten and Compress as undoable document transforms.
 */

import { useCallback } from 'react';
import type { DocumentTransformInput, DocumentTransformOutput } from './usePDFDocument';
import { flattenDocument, refreshSourceAnnotations, FlattenDocumentResult } from '../utils/documentTransforms';
import type { FlattenScope } from '../utils/flatten';
import { compressPdf, CompressOptions, CompressResult } from '../utils/compress';
import { canvasImageCodec } from '../utils/canvasImageCodec';
import { withPdfJsDocument } from '../utils/pdfjsReload';

type ApplyTransform = <T extends DocumentTransformOutput>(
  type: string,
  transform: (input: DocumentTransformInput) => Promise<T | null>
) => Promise<T | null>;

export interface CompressAnalysis {
  /** The committed pdfData the analysis started from; Apply refuses if it changed. */
  source: Uint8Array;
  options: CompressOptions;
  result: CompressResult;
}

export class StaleAnalysisError extends Error {
  constructor() {
    super('The document changed after the analysis. Analyze again before applying.');
    this.name = 'StaleAnalysisError';
  }
}

export function useFinalizeActions(applyDocumentTransform: ApplyTransform) {
  const flatten = useCallback(
    (scope: FlattenScope): Promise<(FlattenDocumentResult & DocumentTransformOutput) | null> =>
      applyDocumentTransform('flatten', async ({ doc, bakedBytes }) => {
        const result = await flattenDocument({ pdfData: bakedBytes, pages: doc.pages, scope });
        const pages = await withPdfJsDocument(result.pdfData, (pdf) => refreshSourceAnnotations(pdf, result.pages));
        return { ...result, pages };
      }),
    [applyDocumentTransform]
  );

  /** Compute the compressed bytes without committing (serialized with page ops, on baked values). */
  const analyzeCompress = useCallback(
    async (options: CompressOptions): Promise<CompressAnalysis | null> => {
      let analysis: CompressAnalysis | null = null;
      await applyDocumentTransform('compress-analyze', async ({ doc, bakedBytes }) => {
        const result = await compressPdf(bakedBytes, options, options.lossy ? canvasImageCodec : undefined);
        analysis = { source: doc.pdfData, options, result };
        return null; // analysis only — nothing is committed
      });
      return analysis;
    },
    [applyDocumentTransform]
  );

  const applyCompress = useCallback(
    async (analysis: CompressAnalysis): Promise<boolean> => {
      const out = await applyDocumentTransform('compress', async ({ doc }) => {
        if (doc.pdfData !== analysis.source) throw new StaleAnalysisError();
        if (!analysis.result.improved) return null;
        return { pdfData: analysis.result.bytes };
      });
      return out !== null;
    },
    [applyDocumentTransform]
  );

  return { flatten, analyzeCompress, applyCompress };
}
