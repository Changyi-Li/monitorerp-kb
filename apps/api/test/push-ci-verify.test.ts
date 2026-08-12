import { expect, it } from 'vitest'

// Deliberate failure for push-CI verification (issue #42, AC5). Removed in
// the next commit — this file never lands on main in the final state.
it('deliberately fails to prove push CI reds', () => {
  expect(1).toBe(2)
})
