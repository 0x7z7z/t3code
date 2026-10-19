/**
 * A per-load nonce prevents annotation ids colliding with drafts that survive reloads.
 * Plain-HTTP previews lack randomUUID; getRandomValues works without a secure context.
 */
export function createAnnotationIdSource(): (prefix: string) => string {
  const pageLoad = Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) =>
    part.toString(36),
  ).join("");
  let sequence = 0;
  return (prefix) => {
    sequence += 1;
    return `${prefix}_${pageLoad}_${sequence.toString(36)}`;
  };
}
