import { describe, expect, it } from 'vitest'
import { isLateProgressNotification } from '../src/catalog.js'

describe('isLateProgressNotification', () => {
  // The SDK routes an unmatched `notifications/progress` to `_onerror` with this
  // exact wording (client `src-*.mjs:5934`). A live call is matched by token and
  // never reaches the error path, so this identifies a notification whose call
  // has no reader left.
  const late = new Error('Received a progress notification for an unknown token: '
    + '{"method":"notifications/progress","params":{"progress":0,"total":1,"progressToken":6}}')

  it('recognises a late progress notification', () => {
    expect(isLateProgressNotification(late)).toBe(true)
  })

  it('keeps real transport failures reportable', () => {
    const lost = new Error('Connection closed')
    expect(isLateProgressNotification(lost)).toBe(false)
    expect(isLateProgressNotification(new Error('Request timed out'))).toBe(false)
    expect(isLateProgressNotification(new Error('other progress failure'))).toBe(false)
  })

  it('ignores values that are not errors', () => {
    expect(isLateProgressNotification('Received a progress notification for an unknown token')).toBe(false)
    expect(isLateProgressNotification(undefined)).toBe(false)
    expect(isLateProgressNotification(null)).toBe(false)
  })
})