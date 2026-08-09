/**
 * Wire protocol version. Bumped on any incompatible message change.
 * The server rejects hellos with a mismatched version; clients then prompt
 * for a reload. Never derive wire formats from runtime class names or other
 * implementation details.
 */
export const PROTOCOL_VERSION = 1
