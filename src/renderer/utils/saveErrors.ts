import { DecodeLimitError } from './boundedDecode';
import { ContentNotExaminedError } from './pdfStreamUtils';

/**
 * What the user is told when a save fails. Content that could not be examined
 * or decoded gets its specific message (the text may still be in the file);
 * anything else keeps the generic message.
 */
export function saveFailureMessage(error: unknown): string {
  if (error instanceof ContentNotExaminedError || error instanceof DecodeLimitError) {
    return `Failed to save: ${error.message}`;
  }
  return 'Failed to save document';
}
