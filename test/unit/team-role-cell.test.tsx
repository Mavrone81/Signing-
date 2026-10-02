// Settings → Team role control, rendered in jsdom with React's own renderer.
// Proves the select shows the SAVED role after a change (it used to snap back
// to the original until a refresh), returns to the stored role when a change is
// refused, and that an owner must confirm before demoting themselves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const actions = vi.hoisted(() => ({
  changeRoleAction: vi.fn(),
  addMemberAction: vi.fn(async () => ({ status: 'idle' })),
  removeMemberAction: vi.fn(),
}))
vi.mock('../../src/app/(app)/settings/team/actions', () => actions)

import { TeamManager } from '../../src/app/(app)/settings/team/TeamManager'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = { membershipId: 'm1', userId: 'u1', name: 'Me', email: 'me@x.com', role: 'owner' as const, joinedAt: new Date() }
const them = { membershipId: 'm2', userId: 'u2', name: 'Them', email: 'them@x.com', role: 'member' as const, joinedAt: new Date() }

let host: HTMLDivElement
let root: Root

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<TeamManager members={[me, them]} isOwner currentUserId="u1" emailConfigured />)
  })
}

const selectFor = (name: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="Role for ${name}"]`)!

async function choose(name: string, role: string) {
  const sel = selectFor(name)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(sel, role)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function save(name: string) {
  const form = selectFor(name).closest('form')!
  await act(async () => {
    form.requestSubmit()
  })
}

beforeEach(async () => {
  actions.changeRoleAction.mockReset()
  await render()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('role control', () => {
  it('keeps showing the saved role and says so', async () => {
    actions.changeRoleAction.mockResolvedValue({ status: 'saved', role: 'admin' })
    await choose('Them', 'admin')
    await save('Them')
    expect(actions.changeRoleAction).toHaveBeenCalledTimes(1)
    expect(selectFor('Them').value).toBe('admin')
    expect(host.textContent).toContain('Saved as Admin.')
  })

  it('returns to the stored role and shows why when the change is refused', async () => {
    actions.changeRoleAction.mockResolvedValue({ status: 'error', message: 'Only an owner can change roles.' })
    await choose('Them', 'admin')
    await save('Them')
    expect(selectFor('Them').value).toBe('member')
    expect(host.textContent).toContain('Only an owner can change roles.')
  })

  it('asks an owner to confirm demoting themselves, and does nothing if they cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await choose('Me', 'member')
    await save('Me')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(actions.changeRoleAction).not.toHaveBeenCalled()
  })

  it('does not ask when an owner changes someone else', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    actions.changeRoleAction.mockResolvedValue({ status: 'saved', role: 'admin' })
    await choose('Them', 'admin')
    await save('Them')
    expect(confirm).not.toHaveBeenCalled()
  })
})
