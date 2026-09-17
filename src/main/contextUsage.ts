import { app } from 'electron'
import { open, realpath } from 'fs/promises'
import { join } from 'path'
import { isPathInside } from '../shared/hubLogic'
import { transcriptUsage, usageFromTranscriptTail } from '../shared/switchingCost'
import type { ContextUsage } from '../shared/types'

// v1.1 fallback for context size when the status line has not reported: the
// last main-thread assistant turn's usage metadata, read from the TAIL of the
// session transcript. Only token counts are extracted (usageFromTranscriptTail);
// no message content is kept, and the whole transcript is never reread.
//
// The path arrives in untrusted hook payloads, so it is only honored inside
// Claude Code's own transcript folder (~/.claude/projects/**.jsonl).

const TAIL_BYTES = 256 * 1024

function transcriptsRoot(): string {
  return join(app.getPath('home'), '.claude', 'projects')
}

export async function readTranscriptUsage(
  transcriptPath: string | undefined,
  modelId: string | undefined,
  now = Date.now()
): Promise<ContextUsage | undefined> {
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath)) return undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const real = await realpath(transcriptPath)
    const root = await realpath(transcriptsRoot())
    if (!isPathInside(real, root)) return undefined
    handle = await open(real, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    if (length <= 0) return undefined
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    const usage = usageFromTranscriptTail(buf.toString('utf8'))
    return usage ? transcriptUsage(usage.tokens, modelId ?? usage.model, now) : undefined
  } catch {
    return undefined // missing, locked or unreadable — size stays unknown rather than guessed
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
