/**
 * Chunked in-memory sink for the MP4 muxer.
 *
 * The muxer writes at arbitrary positions (it patches headers at the end), so a plain append
 * stream is not enough. Data is kept in fixed-size chunks to avoid one giant ArrayBuffer.
 * Adapted from the reference project (MIT, (c) 2026 Sam Bhattacharyya).
 */
export default class InMemoryStorage {
  private readonly chunkSize: number;
  private chunks = new Map<number, Uint8Array>();
  private _size = 0;

  constructor(chunkSize = 8 * 1024 * 1024) {
    this.chunkSize = chunkSize;
  }

  write(data: Uint8Array, position: number): void {
    this._size = Math.max(this._size, position + data.byteLength);

    const first = Math.floor(position / this.chunkSize);
    const last = Math.floor((position + data.byteLength - 1) / this.chunkSize);

    for (let index = first; index <= last; index++) {
      const chunkStart = index * this.chunkSize;
      const overlapStart = Math.max(position, chunkStart);
      const overlapEnd = Math.min(position + data.byteLength, chunkStart + this.chunkSize);
      if (overlapEnd <= overlapStart) continue;

      let chunk = this.chunks.get(index);
      if (!chunk) {
        chunk = new Uint8Array(this.chunkSize);
        this.chunks.set(index, chunk);
      }
      const sourceOffset = overlapStart - position;
      chunk.set(data.subarray(sourceOffset, sourceOffset + (overlapEnd - overlapStart)), overlapStart - chunkStart);
    }
  }

  get size(): number {
    return this._size;
  }

  toBlob(type: string): Blob {
    if (this.chunks.size === 0) return new Blob([], { type });

    const indices = Array.from(this.chunks.keys()).sort((a, b) => a - b);
    const parts: BlobPart[] = [];
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      const chunk = this.chunks.get(index)!;
      const isLast = i === indices.length - 1;
      const remaining = this._size - index * this.chunkSize;
      parts.push((isLast && remaining < this.chunkSize ? chunk.slice(0, remaining) : chunk) as unknown as BlobPart);
    }
    return new Blob(parts, { type });
  }

  /** Drops all buffered data. Call after toBlob() so the memory can be reclaimed. */
  clear(): void {
    this.chunks.clear();
    this._size = 0;
  }
}
