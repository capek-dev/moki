export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8192;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function requireAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || !ATTACHMENT_ID.test(value)) throw new Error('Invalid attachment.');
  return value.toLowerCase();
}

export function attachmentDirectories(dataDir: string) {
  const root = `${dataDir}/attachments`;
  return { root, drafts: `${root}/drafts`, content: `${root}/content` };
}

export function attachmentUrl(id: string): string {
  return `moki-attachment://${requireAttachmentId(id)}/`;
}

export function validatePng(bytes: Uint8Array): { byteSize: number; width: number; height: number } {
  if (bytes.byteLength < 24 || bytes.byteLength > MAX_IMAGE_BYTES || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) throw new Error('Invalid screenshot.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16); const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) throw new Error('Invalid screenshot dimensions.');
  return { byteSize: bytes.byteLength, width, height };
}
