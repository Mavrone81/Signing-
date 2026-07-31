'use client'

import { useActionState, useState } from 'react'
import { createKeyAction, revokeKeyAction, type CreateKeyState } from './actions'
import type { ApiKeySummary } from '@/server/api-keys/actions'

const fieldClass =
  'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

function fmt(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ApiKeysManager({ keys }: { keys: ApiKeySummary[] }) {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createKeyAction, { status: 'idle' })
  const [copied, setCopied] = useState(false)

  async function copy(raw: string) {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable (non-secure context) — user can select+copy.
    }
  }

  return (
    <div className="mt-6 space-y-8">
      {/* Create */}
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <label className="mb-1.5 block text-[13px] font-medium text-ink">New key name</label>
          <input name="name" type="text" placeholder="e.g. Production integration" maxLength={120} className={fieldClass} />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark disabled:opacity-60"
        >
          {pending ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {state.status === 'error' && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
          {state.message}
        </div>
      )}

      {/* The full key — shown ONCE. */}
      {state.status === 'created' && (
        <div className="rounded-xl border border-brand-primary/30 bg-brand-primary/5 p-4">
          <p className="text-[13px] font-medium text-ink">
            Key “{state.name}” created. Copy it now — it won’t be shown again.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[13px] text-ink">
              {state.raw}
            </code>
            <button
              type="button"
              onClick={() => copy(state.raw)}
              className="rounded-lg border border-edge-strong px-3 py-2 text-[13px] font-medium text-ink hover:bg-shell"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-muted">
            Store it securely (e.g. a secrets manager). Only its prefix is kept on our side.
          </p>
        </div>
      )}

      {/* List */}
      <div>
        <h2 className="mb-2 text-[15px] font-semibold text-ink">Your keys</h2>
        {keys.length === 0 ? (
          <p className="text-[13px] text-muted">No API keys yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-edge">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="bg-shell text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Prefix</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Last used</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-t border-edge">
                    <td className="px-4 py-2.5 text-ink">{k.name}</td>
                    <td className="px-4 py-2.5">
                      <code className="text-muted">{k.prefix}…</code>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{fmt(k.createdAt)}</td>
                    <td className="px-4 py-2.5 text-muted">{fmt(k.lastUsedAt)}</td>
                    <td className="px-4 py-2.5">
                      {k.revokedAt ? (
                        <span className="text-danger">Revoked</span>
                      ) : (
                        <span className="text-brand-primary-dark">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!k.revokedAt && (
                        <form action={revokeKeyAction}>
                          <input type="hidden" name="id" value={k.id} />
                          <button type="submit" className="text-[13px] font-medium text-danger hover:underline">
                            Revoke
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
