// Upload validation mirrors RagFlow's supported formats (research #2,
// live-verified on v0.26.4). The full list lives in
// docs/research/ragflow-as-file-store.md on the research branch.

const DOCUMENT_SUFFIXES = ['pdf', 'md', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'html', 'htm', 'epub']
const SOURCE_SUFFIXES = [
  'c', 'cpp', 'h', 'java', 'js', 'ts', 'go', 'rb', 'py', 'php', 'sh', 'sql',
  'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'log', 'css', 'vue', 'cs',
]
const AUDIO_SUFFIXES = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']
const VISUAL_SUFFIXES = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico']

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024 // 1 GiB, matches nginx client_max_body_size
export const MAX_NAME_BYTES = 255

const SUPPORTED = new Set([...DOCUMENT_SUFFIXES, ...SOURCE_SUFFIXES, ...AUDIO_SUFFIXES, ...VISUAL_SUFFIXES])

export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

export function isSupportedSuffix(ext: string): boolean {
  return SUPPORTED.has(ext)
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/** chunk_method derivation per the spec: pptx → presentation, images → picture, audio → audio, else naive. */
export function deriveChunkMethod(ext: string): string {
  if (ext === 'pptx') return 'presentation'
  if (VISUAL_SUFFIXES.includes(ext)) return 'picture'
  if (AUDIO_SUFFIXES.includes(ext)) return 'audio'
  return 'naive'
}

/** Strips characters that could inject multipart headers or break Content-Disposition. */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, '')
}

/** The only characters valid in a bare content-disposition filename parameter. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/** Characters encodeURIComponent leaves bare but RFC 5987 attr-char forbids. */
const RFC5987_ATTR_EXTRA = /['()*]/g

/** Percent-encodes a filename for the RFC 5987 filename* parameter. */
function rfc5987Value(name: string): string {
  return encodeURIComponent(name).replace(RFC5987_ATTR_EXTRA, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Builds the Content-Disposition header for a download response. A bare
 * `filename` parameter cannot carry characters above U+00FF (or control
 * characters): Node's Response constructor rejects them as invalid header
 * bytes (issue #18). The full name therefore goes in the RFC 5987
 * `filename*` parameter and the bare parameter gets a mangled ASCII
 * fallback — modern browsers use `filename*`, legacy clients get the
 * fallback.
 */
export function contentDisposition(filename: string): string {
  const sanitized = sanitizeFilename(filename)
  if (PRINTABLE_ASCII.test(sanitized)) {
    return `attachment; filename="${sanitized}"`
  }
  const fallback = sanitized.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Value(sanitized)}`
}

/**
 * A chunk method that is guaranteed to differ from the stored one, used by
 * withdraw's parser-flip reset (a same-value PUT would be a no-op). The
 * stored method is restored on the next publish.
 */
export function withdrawChunkMethod(stored: string): string {
  return stored === 'naive' ? 'picture' : 'naive'
}
