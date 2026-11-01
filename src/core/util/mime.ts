/** File extension for an image MIME type (Studio screenshots are JPEG; others may be PNG). */
export function extFor(mime: string): string {
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/webp/i.test(mime)) return 'webp';
  return 'png';
}

export function mimeForPath(path: string): string | null {
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.webp$/i.test(path)) return 'image/webp';
  return null;
}
