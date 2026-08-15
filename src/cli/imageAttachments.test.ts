import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasImageReference,
  macOSClipboardCaptureInvocation,
  parseMacOSClipboardCaptureOutput,
  reconcileDraftImagePrompt,
  resolveImagePrompt,
} from './imageAttachments'

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

describe('resolveImagePrompt', () => {
  it('turns pasted image paths into local attachments and prompt placeholders', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-image-workspace-'))
    try {
      const imagePath = join(workspace, 'shot.png')
      writeFileSync(imagePath, TINY_PNG)

      const result = resolveImagePrompt(`inspect ${imagePath}`, workspace)

      expect(result.warnings).toEqual([])
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]?.id).toBe('image1')
      expect(result.attachments[0]?.mime).toBe('image/png')
      expect(existsSync(result.attachments[0]!.path)).toBe(true)
      expect(result.prompt).toBe('inspect [Image #1]')
      expect(result.prompt).not.toContain('<attachments>')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('normalizes explicit image placeholders and keeps draft attachments', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-image-workspace-'))
    try {
      const imagePath = join(workspace, 'shot.png')
      writeFileSync(imagePath, TINY_PNG)

      const result = resolveImagePrompt('<image1> compare with [Image 2]', workspace, {
        existingAttachments: [{
          id: 'image1',
          type: 'image',
          path: imagePath,
          mime: 'image/png',
          filename: 'shot.png',
          size: TINY_PNG.length,
        }, {
          id: 'image2',
          type: 'image',
          path: imagePath,
          mime: 'image/png',
          filename: 'shot.png',
          size: TINY_PNG.length,
        }],
      })

      expect(result.warnings).toEqual([])
      expect(result.attachments).toHaveLength(2)
      expect(result.attachments[0]?.path).toBe(imagePath)
      expect(result.prompt).toBe('[Image #1] compare with [Image #2]')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('turns Codex image markup into a single image attachment', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-image-workspace-'))
    try {
      const imagePath = join(workspace, 'screen.png')
      writeFileSync(imagePath, TINY_PNG)

      const result = resolveImagePrompt([
        `please inspect <image name=[Image #1] path="${imagePath}">`,
        'terminal screenshot text that should not be sent as user text',
        '</image>',
      ].join('\n'), workspace)

      expect(result.warnings).toEqual([])
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]?.filename).toBe('screen.png')
      expect(result.prompt).toBe('please inspect [Image #1]')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('detects image references before routing pasted text through attachment handling', () => {
    expect(hasImageReference('plain text only')).toBe(false)
    expect(hasImageReference(String.raw`<image name=[Image #1] path="C:\Temp\shot.png">text</image>`)).toBe(true)
    expect(hasImageReference('see ![screen](./shot.webp)')).toBe(true)
  })

  it('renumbers draft image placeholders after deletion', () => {
    const attachments = [
      { id: 'image1', type: 'image' as const, path: 'one.png', mime: 'image/png', filename: 'one.png', size: 1 },
      { id: 'image2', type: 'image' as const, path: 'two.png', mime: 'image/png', filename: 'two.png', size: 1 },
    ]

    const result = reconcileDraftImagePrompt('[Image #2] explain', attachments)

    expect(result.prompt).toBe('[Image #1] explain')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.filename).toBe('two.png')
    expect(result.attachments[0]?.id).toBe('image1')
  })
})

describe('macOS clipboard capture', () => {
  it('uses the native AppKit pasteboard and passes the output path as an argument', () => {
    const invocation = macOSClipboardCaptureInvocation('/tmp/turboflux clipboard.png')

    expect(invocation.command).toBe('osascript')
    expect(invocation.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e'])
    expect(invocation.args[3]).toContain('NSPasteboard.generalPasteboard')
    expect(invocation.args[3]).toContain('NSBitmapImageFileTypePNG')
    expect(invocation.args.at(-1)).toBe('/tmp/turboflux clipboard.png')
  })

  it('normalizes native clipboard output without trusting malformed payloads', () => {
    expect(parseMacOSClipboardCaptureOutput(JSON.stringify({
      filePaths: ['/tmp/one.png', '/tmp/one.png', 7, ''],
      captured: true,
    }))).toEqual({ filePaths: ['/tmp/one.png'], captured: true })
    expect(parseMacOSClipboardCaptureOutput('not json')).toEqual({ filePaths: [], captured: false })
  })
})
