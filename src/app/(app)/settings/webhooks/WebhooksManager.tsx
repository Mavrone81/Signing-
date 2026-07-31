'use client'

import { useActionState } from 'react'
import {
  createWebhookAction,
  toggleWebhookAction,
  deleteWebhookAction,
  type WebhookFormState,
} from './actions'
import type { WebhookSummary } from '@/server/webhooks/actions'

const fieldClass =
  'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

export function WebhooksManager({
  webhooks,
  allEvents,
}: {
  webhooks: WebhookSummary[]
  allEvents: string[]
}) {
  const [state, action, pending] = useActionState<WebhookFormState, FormData>(createWebhookAction, { status: 'idle' })

  return (
    <div className="mt-6 space-y-8">
      {/* Add endpoint */}
      <form action={action} className="space-y-4 rounded-xl border border-edge p-4">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Endpoint URL</label>
          <input name="url" type="url" placeholder="https://example.com/webhooks/bevorasign" className={fieldClass} />
          <p className="mt-1 text-[12px] text-muted">Must be a public https:// URL. Internal addresses are rejected.</p>
        </div>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">Events</span>
          <div className="flex flex-wrap gap-3">
            {allEvents.map((e) => (
              <label key={e} className="flex items-center gap-2 text-[13px] text-ink">
                <input type="checkbox" name="events" value={e} defaultChecked className="h-4 w-4 accent-brand-primary" />
                <code>{e}</code>
              </label>
            ))}
          </div>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark disabled:opacity-60"
        >
          {pending ? 'Adding…' : 'Add endpoint'}
        </button>
        {state.status === 'error' && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
            {state.message}
          </div>
        )}
      </form>

      {/* List */}
      <div>
        <h2 className="mb-2 text-[15px] font-semibold text-ink">Your endpoints</h2>
        {webhooks.length === 0 ? (
          <p className="text-[13px] text-muted">No webhook endpoints yet.</p>
        ) : (
          <ul className="space-y-3">
            {webhooks.map((w) => (
              <li key={w.id} className="rounded-xl border border-edge p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-all text-[14px] font-medium text-ink">{w.url}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {w.events.map((e) => (
                        <span key={e} className="rounded-md bg-shell px-2 py-0.5 text-[12px] text-muted">
                          {e}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 text-[12px] font-medium ${w.enabled ? 'text-brand-primary-dark' : 'text-muted'}`}
                  >
                    {w.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>

                <div className="mt-3">
                  <span className="text-[12px] font-medium uppercase tracking-wide text-muted">Signing secret</span>
                  <code className="mt-1 block break-all rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[12px] text-ink">
                    {w.secret}
                  </code>
                </div>

                <div className="mt-3 flex items-center gap-4">
                  <form action={toggleWebhookAction}>
                    <input type="hidden" name="id" value={w.id} />
                    <input type="hidden" name="enabled" value={w.enabled ? '0' : '1'} />
                    <button type="submit" className="text-[13px] font-medium text-brand-primary hover:underline">
                      {w.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </form>
                  <form action={deleteWebhookAction}>
                    <input type="hidden" name="id" value={w.id} />
                    <button type="submit" className="text-[13px] font-medium text-danger hover:underline">
                      Remove
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
