import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { WriterError } from '../types.js';
import { agyFailure } from './agy-errors.js';

const MAX_READ_BYTES = 65536;
const MAX_LINE_CHARS = 8192;

/** Only agy's generation retry loop is authoritative. Startup and telemetry
 * failures can be transient. Returned errors describe retry progress, never
 * authorize terminating an otherwise healthy turn. */
function retryError(line: string): WriterError | undefined {
  const detail = line.match(/\brun\.go:\d+\]\s+Run: attempt \d+ failed \((.*)\), retrying in /)?.[1];
  if (!detail) return;
  const error = agyFailure(detail);
  if (error.code !== 'AGY_EXIT_ERROR') return error;
}

/** Incremental, bounded reader for a dedicated --log-file belonging to one
 * session. Never returns raw log text, prompts, tool arguments or credentials. */
export class AgyDiagnostics {
  private offset = 0;
  private identity?: string;
  private decoder = new StringDecoder('utf8');
  private line = '';
  private droppingLine = false;
  private closed = false;
  constructor(private path: string) {}

  poll(): WriterError | undefined {
    if (this.closed) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, 'r');
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.identity !== identity || stat.size < this.offset) {
        this.offset = 0; this.line = ''; this.droppingLine = false;
        this.decoder = new StringDecoder('utf8');
      }
      this.identity = identity;
      const length = Math.min(MAX_READ_BYTES, Math.max(0, stat.size - this.offset));
      if (!length) return;
      const buffer = Buffer.allocUnsafe(length);
      const count = readSync(fd, buffer, 0, length, this.offset);
      this.offset += count;
      const text = this.decoder.write(buffer.subarray(0, count));
      for (const part of text.split(/(?<=\n)/)) {
        if (!this.droppingLine) {
          if (this.line.length + part.length > MAX_LINE_CHARS) { this.line = ''; this.droppingLine = true; }
          else this.line += part;
        }
        if (part.endsWith('\n')) {
          const error = this.droppingLine ? undefined : retryError(this.line);
          this.line = ''; this.droppingLine = false;
          if (error) return error;
        }
      }
    } catch (error) {
      // The CLI creates its log asynchronously, including after session init.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return new WriterError('AGY_DIAGNOSTICS_ERROR', 'Unable to read the dedicated Provider diagnostics log; session stopped.');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  close(): void { this.closed = true; this.line = ''; this.decoder = new StringDecoder('utf8'); }
}
