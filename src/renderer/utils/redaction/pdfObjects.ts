/**
 * Small typed helpers over pdf-lib's object model, shared by the redaction
 * modules. Every lookup tolerates indirect references and wrong types by
 * returning undefined instead of throwing.
 */
import { decodeRawStreamBounded } from '../boundedDecode';
import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

export function resolve(context: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  let cur = obj;
  // Bounded to avoid pathological reference chains.
  for (let i = 0; cur instanceof PDFRef && i < 32; i++) cur = context.lookup(cur);
  return cur instanceof PDFRef ? undefined : cur;
}

export function getDict(context: PDFContext, obj: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(context, obj);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function getStream(context: PDFContext, obj: PDFObject | undefined): PDFStream | undefined {
  const v = resolve(context, obj);
  return v instanceof PDFStream ? v : undefined;
}

export function getArray(context: PDFContext, obj: PDFObject | undefined): PDFArray | undefined {
  const v = resolve(context, obj);
  return v instanceof PDFArray ? v : undefined;
}

export function getNumber(context: PDFContext, obj: PDFObject | undefined): number | undefined {
  const v = resolve(context, obj);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function getName(context: PDFContext, obj: PDFObject | undefined): string | undefined {
  const v = resolve(context, obj);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function getBool(context: PDFContext, obj: PDFObject | undefined): boolean | undefined {
  const v = resolve(context, obj);
  return v instanceof PDFBool ? v.asBoolean() : undefined;
}

export function dictGet(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  return dict?.get(PDFName.of(key));
}

export function numberArray(context: PDFContext, obj: PDFObject | undefined): number[] | undefined {
  const arr = getArray(context, obj);
  if (!arr) return undefined;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const n = getNumber(context, arr.get(i));
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

/** Names of all filters on a stream, in order. */
export function streamFilters(context: PDFContext, stream: PDFStream): string[] {
  const f = resolve(context, stream.dict.get(PDFName.of('Filter')));
  if (!f) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < f.size(); i++) {
      const n = getName(context, f.get(i));
      if (n) names.push(n);
    }
    return names;
  }
  return [];
}

/**
 * Fully decode a stream's bytes. Throws when a filter is unsupported or the
 * data is corrupt — unlike pdfStreamUtils.decodeStream, it never silently
 * returns the still-encoded bytes, because redaction must know whether it
 * actually saw the content.
 */
export function decodeStreamStrict(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    // Bounded: the input is an untrusted PDF; an overflow throws, which callers
    // treat as "could not examine" (never as clean).
    return decodeRawStreamBounded(stream);
  }
  // PDFContentStream / PDFFlateStream built in-memory by pdf-lib keep their
  // plaintext separately; getContents() would return the deflated bytes.
  const flate = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  if (typeof flate.getUnencodedContents === 'function') return flate.getUnencodedContents();
  return stream.getContents();
}

export function stringOrHexText(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return undefined;
}
