const REQUEST_MAGIC = 'M0BW';
const RESPONSE_MAGIC = 'M0BR';
const MAX_JSON = 4 * 1024 * 1024;
const MAX_SECRET = 8 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;

export function encodeFrame(value, secret = Buffer.alloc(0), response = false) {
  const json = Buffer.from(JSON.stringify(value));
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
  if (json.length > (response ? MAX_RESPONSE : MAX_JSON) || bytes.length > MAX_SECRET ||
      response && bytes.length) throw new Error('frame_oversized');
  const header = Buffer.alloc(response ? 9 : 13);
  header.write(response ? RESPONSE_MAGIC : REQUEST_MAGIC);
  header[4] = 1;
  header.writeUInt32BE(json.length, 5);
  if (!response) header.writeUInt32BE(bytes.length, 9);
  return Buffer.concat([header, json, bytes]);
}

export class FrameReader {
  constructor({ response = false } = {}) {
    this.response = response;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    const headerSize = this.response ? 9 : 13;
    while (this.buffer.length >= headerSize) {
      const header = this.buffer;
      if (header.toString('ascii', 0, 4) !== (this.response ? RESPONSE_MAGIC : REQUEST_MAGIC) || header[4] !== 1) {
        throw new Error('frame_protocol');
      }
      const jsonLength = header.readUInt32BE(5);
      const secretLength = this.response ? 0 : header.readUInt32BE(9);
      if (jsonLength > (this.response ? MAX_RESPONSE : MAX_JSON) || secretLength > MAX_SECRET) {
        throw new Error('frame_oversized');
      }
      const length = headerSize + jsonLength + secretLength;
      if (this.buffer.length < length) break;
      const json = this.buffer.subarray(headerSize, headerSize + jsonLength);
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)); }
      catch { throw new Error('frame_json_invalid'); }
      frames.push({ value, secret: Buffer.from(this.buffer.subarray(headerSize + jsonLength, length)) });
      this.buffer = this.buffer.subarray(length);
    }
    if (this.buffer.length > headerSize + (this.response ? MAX_RESPONSE : MAX_JSON) + MAX_SECRET) throw new Error('frame_oversized');
    return frames;
  }

  end() { if (this.buffer.length) throw new Error('frame_partial_eof'); }
}
