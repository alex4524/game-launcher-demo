import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ChunkInfo } from '../shared/types';

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file: string, onBytes?: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => {
        h.update(d);
        onBytes?.(d.length);
      })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Hash each chunk of an existing file and return the indexes whose hash matches the
 * expected chunk list. Chunks that lie beyond the end of the file never match.
 */
export async function matchingChunks(file: string, chunks: ChunkInfo[], onBytes?: (n: number) => void): Promise<number[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const good: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.offset + c.size > size) continue;
      const buf = Buffer.alloc(c.size);
      await fh.read(buf, 0, c.size, c.offset);
      onBytes?.(c.size);
      if (sha256(buf) === c.sha256) good.push(i);
    }
    return good;
  } finally {
    await fh.close();
  }
}
