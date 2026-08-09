import { describe, expect, it } from 'vitest'
import { contentDisposition } from '../src/ragflow/files.js'

describe('contentDisposition', () => {
  it('keeps the legacy shape for printable-ASCII names', () => {
    expect(contentDisposition('notes.md')).toBe('attachment; filename="notes.md"')
    expect(contentDisposition('问题清单模板 v3.docx')).not.toBe('attachment; filename="问题清单模板 v3.docx"')
  })

  it('puts the full non-ASCII name in the RFC 5987 filename* parameter', () => {
    const disposition = contentDisposition('问题清单模板 v3.docx')
    expect(disposition).toBe(
      `attachment; filename="______ v3.docx"; filename*=UTF-8''${encodeURIComponent('问题清单模板 v3.docx')}`,
    )
  })

  it('keeps the bare filename parameter ASCII-only', () => {
    for (const name of ['问题清单模板 v3.docx', 'a漢b.docx', '全部非ASCII.docx']) {
      const disposition = contentDisposition(name)
      const bare = disposition.match(/^attachment; filename="([^"]*)"/)
      expect(bare?.[1]).toMatch(/^[\x20-\x7e]*$/)
    }
  })

  it('percent-encodes RFC 5987 attr-char exclusions (\'()*) in the filename* parameter', () => {
    const disposition = contentDisposition("附件'(最终).docx")
    expect(disposition).toContain(`filename*=UTF-8''%E9%99%84%E4%BB%B6%27%28%E6%9C%80%E7%BB%88%29.docx`)
    expect(() => new Response(null, { headers: { 'content-disposition': disposition } })).not.toThrow()
  })

  it('does not crash on characters the ByteString conversion also rejects (control chars)', () => {
    const disposition = contentDisposition('bad\x01name.docx')
    expect(disposition).not.toContain('\x01')
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('bad\x01name.docx')}`)
    expect(() => new Response(null, { headers: { 'content-disposition': disposition } })).not.toThrow()
  })

  it('strips embedded quotes, CR and LF like sanitizeFilename, from both parameters', () => {
    const disposition = contentDisposition('na"me\r\n.docx')
    // No quote, CR or LF inside the quoted parameter value (the two outer
    // quotes are header syntax).
    expect(disposition).toMatch(/^attachment; filename="[^"]*"$/)
    expect(disposition).not.toContain('\r')
    expect(disposition).not.toContain('\n')
    expect(() => new Response(null, { headers: { 'content-disposition': disposition } })).not.toThrow()
  })
})
