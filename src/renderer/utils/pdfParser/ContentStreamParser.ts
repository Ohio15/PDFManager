/**
 * PDF Content Stream Parser
 *
 * A proper tokenizer and parser for PDF content streams.
 * Handles all PDF operators and operand types according to PDF spec.
 */

import {
  PDFOperator,
  PDFOperatorType,
  PDFValue,
  PDFNumber,
  PDFString,
  PDFName,
  PDFArray,
  PDFDict,
  PDFBoolean,
  PDFNull,
  TextState,
  TextMatrix,
  GraphicsState,
  Color,
  Glyph,
  TextRun,
  BoundingBox,
  FontInfo,
} from './types';

// Token types for lexer
type TokenType =
  | 'number'
  | 'string'
  | 'hexstring'
  | 'name'
  | 'keyword'
  | 'arrayStart'
  | 'arrayEnd'
  | 'dictStart'
  | 'dictEnd'
  | 'eof';

interface Token {
  type: TokenType;
  value: string | number;
  start: number;
  end: number;
  raw: Uint8Array;
}

/**
 * Lexer for PDF content streams
 */
export class ContentStreamLexer {
  private data: Uint8Array;
  private pos: number = 0;
  private length: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.length = data.length;
  }

  /**
   * Get all tokens from the stream
   */
  tokenize(): Token[] {
    const tokens: Token[] = [];
    let token: Token | null;

    while ((token = this.nextToken()) !== null) {
      tokens.push(token);
    }

    return tokens;
  }

  /**
   * Get next token from stream
   */
  nextToken(): Token | null {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.length) {
      return null;
    }

    const start = this.pos;
    const ch = this.data[this.pos];

    // String literal (...)
    if (ch === 0x28) { // '('
      return this.readStringLiteral(start);
    }

    // Hex string <...>
    if (ch === 0x3C) { // '<'
      if (this.pos + 1 < this.length && this.data[this.pos + 1] === 0x3C) {
        // Dictionary start <<
        this.pos += 2;
        return {
          type: 'dictStart',
          value: '<<',
          start,
          end: this.pos,
          raw: this.data.slice(start, this.pos)
        };
      }
      return this.readHexString(start);
    }

    // Dictionary end >>
    if (ch === 0x3E && this.pos + 1 < this.length && this.data[this.pos + 1] === 0x3E) {
      this.pos += 2;
      return {
        type: 'dictEnd',
        value: '>>',
        start,
        end: this.pos,
        raw: this.data.slice(start, this.pos)
      };
    }

    // Array start [
    if (ch === 0x5B) { // '['
      this.pos++;
      return {
        type: 'arrayStart',
        value: '[',
        start,
        end: this.pos,
        raw: this.data.slice(start, this.pos)
      };
    }

    // Array end ]
    if (ch === 0x5D) { // ']'
      this.pos++;
      return {
        type: 'arrayEnd',
        value: ']',
        start,
        end: this.pos,
        raw: this.data.slice(start, this.pos)
      };
    }

    // Name /...
    if (ch === 0x2F) { // '/'
      return this.readName(start);
    }

    // Number (including negative and decimal)
    if (this.isDigit(ch) || ch === 0x2D || ch === 0x2B || ch === 0x2E) {
      return this.readNumber(start);
    }

    // Keyword (operator or boolean/null)
    if (this.isRegularChar(ch)) {
      return this.readKeyword(start);
    }

    // Unknown character, skip
    this.pos++;
    return this.nextToken();
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.length) {
      const ch = this.data[this.pos];

      // Whitespace: space, tab, newline, carriage return, form feed
      if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x0C || ch === 0x00) {
        this.pos++;
        continue;
      }

      // Comment: %...
      if (ch === 0x25) { // '%'
        while (this.pos < this.length && this.data[this.pos] !== 0x0A && this.data[this.pos] !== 0x0D) {
          this.pos++;
        }
        continue;
      }

      break;
    }
  }

  private readStringLiteral(start: number): Token {
    this.pos++; // Skip opening '('
    let value = '';
    let depth = 1;
    const bytes: number[] = [];

    while (this.pos < this.length && depth > 0) {
      const ch = this.data[this.pos];

      if (ch === 0x5C) { // '\' escape
        this.pos++;
        if (this.pos < this.length) {
          const escaped = this.data[this.pos];
          switch (escaped) {
            case 0x6E: value += '\n'; bytes.push(0x0A); break; // \n
            case 0x72: value += '\r'; bytes.push(0x0D); break; // \r
            case 0x74: value += '\t'; bytes.push(0x09); break; // \t
            case 0x62: value += '\b'; bytes.push(0x08); break; // \b
            case 0x66: value += '\f'; bytes.push(0x0C); break; // \f
            case 0x28: value += '('; bytes.push(0x28); break;  // \(
            case 0x29: value += ')'; bytes.push(0x29); break;  // \)
            case 0x5C: value += '\\'; bytes.push(0x5C); break; // \\
            case 0x0A: break; // Line continuation (ignore)
            case 0x0D:
              if (this.pos + 1 < this.length && this.data[this.pos + 1] === 0x0A) {
                this.pos++; // Skip CRLF
              }
              break;
            default:
              // Octal escape \ddd
              if (this.isOctalDigit(escaped)) {
                let octal = String.fromCharCode(escaped);
                for (let i = 0; i < 2 && this.pos + 1 < this.length; i++) {
                  const next = this.data[this.pos + 1];
                  if (this.isOctalDigit(next)) {
                    this.pos++;
                    octal += String.fromCharCode(next);
                  } else {
                    break;
                  }
                }
                const code = parseInt(octal, 8);
                value += String.fromCharCode(code);
                bytes.push(code);
              } else {
                value += String.fromCharCode(escaped);
                bytes.push(escaped);
              }
          }
          this.pos++;
        }
      } else if (ch === 0x28) { // '('
        depth++;
        value += '(';
        bytes.push(ch);
        this.pos++;
      } else if (ch === 0x29) { // ')'
        depth--;
        if (depth > 0) {
          value += ')';
          bytes.push(ch);
        }
        this.pos++;
      } else {
        value += String.fromCharCode(ch);
        bytes.push(ch);
        this.pos++;
      }
    }

    return {
      type: 'string',
      value,
      start,
      end: this.pos,
      raw: new Uint8Array(bytes)
    };
  }

  private readHexString(start: number): Token {
    this.pos++; // Skip opening '<'
    let hex = '';

    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (ch === 0x3E) { // '>'
        this.pos++;
        break;
      }
      if (this.isHexDigit(ch)) {
        hex += String.fromCharCode(ch);
      }
      this.pos++;
    }

    // Pad with zero if odd length
    if (hex.length % 2 !== 0) {
      hex += '0';
    }

    // Convert hex to string
    let value = '';
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.substr(i, 2), 16);
      value += String.fromCharCode(code);
      bytes.push(code);
    }

    return {
      type: 'hexstring',
      value,
      start,
      end: this.pos,
      raw: new Uint8Array(bytes)
    };
  }

  private readName(start: number): Token {
    this.pos++; // Skip '/'
    let name = '';

    while (this.pos < this.length) {
      const ch = this.data[this.pos];

      // Name terminates at whitespace or delimiter
      if (this.isWhitespace(ch) || this.isDelimiter(ch)) {
        break;
      }

      // Handle #XX hex escape
      if (ch === 0x23 && this.pos + 2 < this.length) { // '#'
        const h1 = this.data[this.pos + 1];
        const h2 = this.data[this.pos + 2];
        if (this.isHexDigit(h1) && this.isHexDigit(h2)) {
          const hex = String.fromCharCode(h1) + String.fromCharCode(h2);
          name += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }

      name += String.fromCharCode(ch);
      this.pos++;
    }

    return {
      type: 'name',
      value: name,
      start,
      end: this.pos,
      raw: this.data.slice(start, this.pos)
    };
  }

  private readNumber(start: number): Token {
    let numStr = '';
    let hasDecimal = false;

    // Handle sign
    if (this.data[this.pos] === 0x2D || this.data[this.pos] === 0x2B) { // '-' or '+'
      numStr += String.fromCharCode(this.data[this.pos]);
      this.pos++;
    }

    while (this.pos < this.length) {
      const ch = this.data[this.pos];

      if (this.isDigit(ch)) {
        numStr += String.fromCharCode(ch);
        this.pos++;
      } else if (ch === 0x2E && !hasDecimal) { // '.'
        numStr += '.';
        hasDecimal = true;
        this.pos++;
      } else {
        break;
      }
    }

    return {
      type: 'number',
      value: parseFloat(numStr),
      start,
      end: this.pos,
      raw: this.data.slice(start, this.pos)
    };
  }

  private readKeyword(start: number): Token {
    let keyword = '';

    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (this.isWhitespace(ch) || this.isDelimiter(ch)) {
        break;
      }
      keyword += String.fromCharCode(ch);
      this.pos++;
    }

    return {
      type: 'keyword',
      value: keyword,
      start,
      end: this.pos,
      raw: this.data.slice(start, this.pos)
    };
  }

  private isDigit(ch: number): boolean {
    return ch >= 0x30 && ch <= 0x39; // '0'-'9'
  }

  private isOctalDigit(ch: number): boolean {
    return ch >= 0x30 && ch <= 0x37; // '0'-'7'
  }

  private isHexDigit(ch: number): boolean {
    return (ch >= 0x30 && ch <= 0x39) || // '0'-'9'
           (ch >= 0x41 && ch <= 0x46) || // 'A'-'F'
           (ch >= 0x61 && ch <= 0x66);   // 'a'-'f'
  }

  private isWhitespace(ch: number): boolean {
    return ch === 0x00 || ch === 0x09 || ch === 0x0A || ch === 0x0C || ch === 0x0D || ch === 0x20;
  }

  private isDelimiter(ch: number): boolean {
    return ch === 0x28 || ch === 0x29 || // '(' ')'
           ch === 0x3C || ch === 0x3E || // '<' '>'
           ch === 0x5B || ch === 0x5D || // '[' ']'
           ch === 0x7B || ch === 0x7D || // '{' '}'
           ch === 0x2F ||                // '/'
           ch === 0x25;                  // '%'
  }

  private isRegularChar(ch: number): boolean {
    return !this.isWhitespace(ch) && !this.isDelimiter(ch);
  }
}

/**
 * Parser for PDF content streams
 */
export class ContentStreamParser {
  private tokens: Token[];
  private pos: number = 0;
  private operandStack: PDFValue[] = [];
  private operators: PDFOperator[] = [];

  constructor(data: Uint8Array) {
    const lexer = new ContentStreamLexer(data);
    this.tokens = lexer.tokenize();
  }

  /**
   * Parse the content stream into operators
   */
  parse(): PDFOperator[] {
    this.operators = [];
    this.operandStack = [];
    this.pos = 0;

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];

      switch (token.type) {
        case 'number':
          this.operandStack.push({ type: 'number', value: token.value as number });
          this.pos++;
          break;

        case 'string':
        case 'hexstring':
          this.operandStack.push({
            type: 'string',
            value: token.value as string,
            encoding: token.type === 'hexstring' ? 'hex' : 'literal',
            raw: new TextDecoder('latin1').decode(token.raw)
          });
          this.pos++;
          break;

        case 'name':
          this.operandStack.push({ type: 'name', value: token.value as string });
          this.pos++;
          break;

        case 'arrayStart':
          this.operandStack.push(this.parseArray());
          break;

        case 'dictStart':
          this.operandStack.push(this.parseDict());
          break;

        case 'keyword':
          this.handleKeyword(token);
          break;

        default:
          this.pos++;
      }
    }

    return this.operators;
  }

  private parseArray(): PDFArray {
    this.pos++; // Skip '['
    const arr: PDFValue[] = [];

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];

      if (token.type === 'arrayEnd') {
        this.pos++;
        break;
      }

      switch (token.type) {
        case 'number':
          arr.push({ type: 'number', value: token.value as number });
          this.pos++;
          break;
        case 'string':
        case 'hexstring':
          arr.push({
            type: 'string',
            value: token.value as string,
            encoding: token.type === 'hexstring' ? 'hex' : 'literal',
            raw: new TextDecoder('latin1').decode(token.raw)
          });
          this.pos++;
          break;
        case 'name':
          arr.push({ type: 'name', value: token.value as string });
          this.pos++;
          break;
        case 'arrayStart':
          arr.push(this.parseArray());
          break;
        case 'dictStart':
          arr.push(this.parseDict());
          break;
        case 'keyword':
          const kw = token.value as string;
          if (kw === 'true') {
            arr.push({ type: 'boolean', value: true });
          } else if (kw === 'false') {
            arr.push({ type: 'boolean', value: false });
          } else if (kw === 'null') {
            arr.push({ type: 'null' });
          }
          this.pos++;
          break;
        default:
          this.pos++;
      }
    }

    return { type: 'array', value: arr };
  }

  private parseDict(): PDFDict {
    this.pos++; // Skip '<<'
    const dict = new Map<string, PDFValue>();
    let key: string | null = null;

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];

      if (token.type === 'dictEnd') {
        this.pos++;
        break;
      }

      if (key === null) {
        // Expecting a name key
        if (token.type === 'name') {
          key = token.value as string;
          this.pos++;
        } else {
          this.pos++;
        }
      } else {
        // Expecting a value
        let value: PDFValue | null = null;

        switch (token.type) {
          case 'number':
            value = { type: 'number', value: token.value as number };
            this.pos++;
            break;
          case 'string':
          case 'hexstring':
            value = {
              type: 'string',
              value: token.value as string,
              encoding: token.type === 'hexstring' ? 'hex' : 'literal',
              raw: new TextDecoder('latin1').decode(token.raw)
            };
            this.pos++;
            break;
          case 'name':
            value = { type: 'name', value: token.value as string };
            this.pos++;
            break;
          case 'arrayStart':
            value = this.parseArray();
            break;
          case 'dictStart':
            value = this.parseDict();
            break;
          case 'keyword':
            const kw = token.value as string;
            if (kw === 'true') {
              value = { type: 'boolean', value: true };
            } else if (kw === 'false') {
              value = { type: 'boolean', value: false };
            } else if (kw === 'null') {
              value = { type: 'null' };
            }
            this.pos++;
            break;
          default:
            this.pos++;
        }

        if (value !== null) {
          dict.set(key, value);
          key = null;
        }
      }
    }

    return { type: 'dict', value: dict };
  }

  private handleKeyword(token: Token): void {
    const keyword = token.value as string;

    // Check for boolean/null
    if (keyword === 'true') {
      this.operandStack.push({ type: 'boolean', value: true });
      this.pos++;
      return;
    }
    if (keyword === 'false') {
      this.operandStack.push({ type: 'boolean', value: false });
      this.pos++;
      return;
    }
    if (keyword === 'null') {
      this.operandStack.push({ type: 'null' });
      this.pos++;
      return;
    }

    // It's an operator - create PDFOperator with collected operands
    const startOffset = this.operandStack.length > 0
      ? this.findOperandStart()
      : token.start;

    // Collect raw bytes for the entire operation
    const rawBytes = this.collectRawBytes(startOffset, token.end);

    this.operators.push({
      operator: keyword as PDFOperatorType,
      operands: [...this.operandStack],
      startOffset,
      endOffset: token.end,
      raw: rawBytes
    });

    this.operandStack = [];
    this.pos++;
  }

  private findOperandStart(): number {
    // Find the start of the first operand
    // This is a simplification - in practice we'd track positions more carefully
    let minStart = Infinity;
    for (let i = this.pos - this.operandStack.length; i < this.pos; i++) {
      if (i >= 0 && i < this.tokens.length) {
        if (this.tokens[i].start < minStart) {
          minStart = this.tokens[i].start;
        }
      }
    }
    return minStart === Infinity ? 0 : minStart;
  }

  private collectRawBytes(start: number, end: number): Uint8Array {
    // Collect all raw bytes between start and end positions
    const bytes: number[] = [];
    for (let i = this.pos - this.operandStack.length; i <= this.pos && i < this.tokens.length; i++) {
      if (i >= 0) {
        for (const b of this.tokens[i].raw) {
          bytes.push(b);
        }
        bytes.push(0x20); // Space between tokens
      }
    }
    return new Uint8Array(bytes);
  }
}

/**
 * Content Stream Interpreter
 * Executes parsed operators and tracks state
 */
export class ContentStreamInterpreter {
  private operators: PDFOperator[];
  private fonts: Map<string, FontInfo>;

  // State stacks
  private graphicsStateStack: GraphicsState[] = [];
  private currentGraphicsState: GraphicsState;

  // Text state
  private inTextObject: boolean = false;
  private textMatrix: TextMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private lineMatrix: TextMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  // Collected text runs
  private textRuns: TextRun[] = [];
  private currentTextRun: Glyph[] = [];
  private textRunOperators: PDFOperator[] = [];

  constructor(operators: PDFOperator[], fonts: Map<string, FontInfo>) {
    this.operators = operators;
    this.fonts = fonts;
    this.currentGraphicsState = this.createDefaultGraphicsState();
  }

  private createDefaultGraphicsState(): GraphicsState {
    return {
      ctm: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      lineWidth: 1,
      lineCap: 0,
      lineJoin: 0,
      miterLimit: 10,
      dashArray: [],
      dashPhase: 0,
      strokeColor: { space: 'DeviceGray', values: [0] },
      fillColor: { space: 'DeviceGray', values: [0] },
      colorSpace: { stroke: 'DeviceGray', fill: 'DeviceGray' },
      textState: {
        charSpacing: 0,
        wordSpacing: 0,
        horizontalScale: 100,
        leading: 0,
        fontName: '',
        fontSize: 12,
        renderMode: 0,
        rise: 0
      }
    };
  }

  /**
   * Interpret all operators and extract text runs
   */
  interpret(): TextRun[] {
    this.textRuns = [];
    let runId = 0;

    for (const op of this.operators) {
      this.executeOperator(op);
    }

    // Finalize any remaining text run
    this.finalizeTextRun(runId);

    return this.textRuns;
  }

  private executeOperator(op: PDFOperator): void {
    switch (op.operator) {
      // Graphics State
      case 'q':
        this.graphicsStateStack.push(JSON.parse(JSON.stringify(this.currentGraphicsState)));
        break;
      case 'Q':
        if (this.graphicsStateStack.length > 0) {
          this.currentGraphicsState = this.graphicsStateStack.pop()!;
        }
        break;
      case 'cm':
        this.applyConcatMatrix(op.operands);
        break;

      // Text State
      case 'Tc':
        this.currentGraphicsState.textState.charSpacing = this.getNumber(op.operands, 0);
        break;
      case 'Tw':
        this.currentGraphicsState.textState.wordSpacing = this.getNumber(op.operands, 0);
        break;
      case 'Tz':
        this.currentGraphicsState.textState.horizontalScale = this.getNumber(op.operands, 0);
        break;
      case 'TL':
        this.currentGraphicsState.textState.leading = this.getNumber(op.operands, 0);
        break;
      case 'Tf':
        this.currentGraphicsState.textState.fontName = this.getName(op.operands, 0);
        this.currentGraphicsState.textState.fontSize = this.getNumber(op.operands, 1);
        break;
      case 'Tr':
        this.currentGraphicsState.textState.renderMode = this.getNumber(op.operands, 0);
        break;
      case 'Ts':
        this.currentGraphicsState.textState.rise = this.getNumber(op.operands, 0);
        break;

      // Text Object
      case 'BT':
        this.inTextObject = true;
        this.textMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        this.lineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        break;
      case 'ET':
        this.inTextObject = false;
        this.finalizeTextRun(this.textRuns.length);
        break;

      // Text Positioning
      case 'Td':
        this.moveText(this.getNumber(op.operands, 0), this.getNumber(op.operands, 1));
        break;
      case 'TD':
        const ty = this.getNumber(op.operands, 1);
        this.currentGraphicsState.textState.leading = -ty;
        this.moveText(this.getNumber(op.operands, 0), ty);
        break;
      case 'Tm':
        this.textMatrix = {
          a: this.getNumber(op.operands, 0),
          b: this.getNumber(op.operands, 1),
          c: this.getNumber(op.operands, 2),
          d: this.getNumber(op.operands, 3),
          e: this.getNumber(op.operands, 4),
          f: this.getNumber(op.operands, 5)
        };
        this.lineMatrix = { ...this.textMatrix };
        break;
      case 'T*':
        this.moveText(0, -this.currentGraphicsState.textState.leading);
        break;

      // Text Showing
      case 'Tj':
        this.showText(op.operands[0], op);
        break;
      case 'TJ':
        this.showTextArray(op.operands[0], op);
        break;
      case "'":
        this.moveText(0, -this.currentGraphicsState.textState.leading);
        this.showText(op.operands[0], op);
        break;
      case '"':
        this.currentGraphicsState.textState.wordSpacing = this.getNumber(op.operands, 0);
        this.currentGraphicsState.textState.charSpacing = this.getNumber(op.operands, 1);
        this.moveText(0, -this.currentGraphicsState.textState.leading);
        this.showText(op.operands[2], op);
        break;

      // Color operators
      case 'g':
        this.currentGraphicsState.fillColor = { space: 'DeviceGray', values: [this.getNumber(op.operands, 0)] };
        break;
      case 'G':
        this.currentGraphicsState.strokeColor = { space: 'DeviceGray', values: [this.getNumber(op.operands, 0)] };
        break;
      case 'rg':
        this.currentGraphicsState.fillColor = {
          space: 'DeviceRGB',
          values: [this.getNumber(op.operands, 0), this.getNumber(op.operands, 1), this.getNumber(op.operands, 2)]
        };
        break;
      case 'RG':
        this.currentGraphicsState.strokeColor = {
          space: 'DeviceRGB',
          values: [this.getNumber(op.operands, 0), this.getNumber(op.operands, 1), this.getNumber(op.operands, 2)]
        };
        break;
      case 'k':
        this.currentGraphicsState.fillColor = {
          space: 'DeviceCMYK',
          values: [
            this.getNumber(op.operands, 0),
            this.getNumber(op.operands, 1),
            this.getNumber(op.operands, 2),
            this.getNumber(op.operands, 3)
          ]
        };
        break;
      case 'K':
        this.currentGraphicsState.strokeColor = {
          space: 'DeviceCMYK',
          values: [
            this.getNumber(op.operands, 0),
            this.getNumber(op.operands, 1),
            this.getNumber(op.operands, 2),
            this.getNumber(op.operands, 3)
          ]
        };
        break;
    }
  }

  private applyConcatMatrix(operands: PDFValue[]): void {
    const m = {
      a: this.getNumber(operands, 0),
      b: this.getNumber(operands, 1),
      c: this.getNumber(operands, 2),
      d: this.getNumber(operands, 3),
      e: this.getNumber(operands, 4),
      f: this.getNumber(operands, 5)
    };
    this.currentGraphicsState.ctm = this.multiplyMatrices(m, this.currentGraphicsState.ctm);
  }

  private multiplyMatrices(m1: TextMatrix, m2: TextMatrix): TextMatrix {
    return {
      a: m1.a * m2.a + m1.b * m2.c,
      b: m1.a * m2.b + m1.b * m2.d,
      c: m1.c * m2.a + m1.d * m2.c,
      d: m1.c * m2.b + m1.d * m2.d,
      e: m1.e * m2.a + m1.f * m2.c + m2.e,
      f: m1.e * m2.b + m1.f * m2.d + m2.f
    };
  }

  private moveText(tx: number, ty: number): void {
    this.lineMatrix = {
      a: 1, b: 0, c: 0, d: 1,
      e: this.lineMatrix.e + tx,
      f: this.lineMatrix.f + ty
    };
    this.textMatrix = { ...this.lineMatrix };
  }

  private showText(value: PDFValue, op: PDFOperator): void {
    if (value.type !== 'string') return;

    const text = value.value;
    const fontInfo = this.fonts.get(this.currentGraphicsState.textState.fontName);
    const fontSize = this.currentGraphicsState.textState.fontSize;
    const charSpacing = this.currentGraphicsState.textState.charSpacing;
    const wordSpacing = this.currentGraphicsState.textState.wordSpacing;
    const hScale = this.currentGraphicsState.textState.horizontalScale / 100;

    this.textRunOperators.push(op);

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const unicode = fontInfo?.toUnicode?.get(charCode) || text[i];
      const width = fontInfo?.widths.get(charCode) || 500; // Default glyph width

      // Calculate position using text rendering matrix
      const trm = this.multiplyMatrices(
        { a: fontSize * hScale, b: 0, c: 0, d: fontSize, e: 0, f: this.currentGraphicsState.textState.rise },
        this.multiplyMatrices(this.textMatrix, this.currentGraphicsState.ctm)
      );

      this.currentTextRun.push({
        charCode,
        unicode,
        width: width * fontSize / 1000,
        x: trm.e,
        y: trm.f,
        fontName: this.currentGraphicsState.textState.fontName,
        fontSize,
        transform: { ...trm }
      });

      // Advance text matrix
      const tx = (width / 1000 * fontSize + charSpacing + (unicode === ' ' ? wordSpacing : 0)) * hScale;
      this.textMatrix.e += tx;
    }
  }

  private showTextArray(value: PDFValue, op: PDFOperator): void {
    if (value.type !== 'array') return;

    this.textRunOperators.push(op);

    for (const item of value.value) {
      if (item.type === 'string') {
        // Text string
        this.showText(item, op);
      } else if (item.type === 'number') {
        // Positioning adjustment (in thousandths of em)
        const adjustment = item.value;
        const hScale = this.currentGraphicsState.textState.horizontalScale / 100;
        const fontSize = this.currentGraphicsState.textState.fontSize;
        this.textMatrix.e -= (adjustment / 1000) * fontSize * hScale;
      }
    }
  }

  private finalizeTextRun(id: number): void {
    if (this.currentTextRun.length === 0) return;

    const text = this.currentTextRun.map(g => g.unicode).join('');
    const bbox = this.calculateBoundingBox(this.currentTextRun);

    this.textRuns.push({
      id: `run-${id}`,
      glyphs: [...this.currentTextRun],
      text,
      boundingBox: bbox,
      fontName: this.currentGraphicsState.textState.fontName,
      fontSize: this.currentGraphicsState.textState.fontSize,
      color: { ...this.currentGraphicsState.fillColor },
      transform: { ...this.textMatrix },
      operators: [...this.textRunOperators],
      modified: false
    });

    this.currentTextRun = [];
    this.textRunOperators = [];
  }

  private calculateBoundingBox(glyphs: Glyph[]): BoundingBox {
    if (glyphs.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const glyph of glyphs) {
      minX = Math.min(minX, glyph.x);
      minY = Math.min(minY, glyph.y);
      maxX = Math.max(maxX, glyph.x + glyph.width);
      maxY = Math.max(maxY, glyph.y + glyph.fontSize);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  private getNumber(operands: PDFValue[], index: number): number {
    const val = operands[index];
    if (val && val.type === 'number') {
      return val.value;
    }
    return 0;
  }

  private getName(operands: PDFValue[], index: number): string {
    const val = operands[index];
    if (val && val.type === 'name') {
      return val.value;
    }
    return '';
  }

  private getString(operands: PDFValue[], index: number): string {
    const val = operands[index];
    if (val && val.type === 'string') {
      return val.value;
    }
    return '';
  }
}
