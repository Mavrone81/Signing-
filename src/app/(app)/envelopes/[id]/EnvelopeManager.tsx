'use client'

import { startTransition, useActionState, useState } from 'react'
import { MAX_INVITE_MESSAGE } from '@/lib/invite-message'
import { saveSignersAction, sendEnvelopeAction, type EnvelopeActionState } from '../actions'

const fieldClass =
  'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

type Row = { key: number; name: string; email: string }

// Signers + invitation note + send, for one envelope. Both forms submit by hand
// (onSubmit + startTransition) so React never resets them after the action —
// the rows and the note stay as the sender left them.
export function EnvelopeManager({
  envelopeId,
  signers,
  initialMessage,
  showLinks,
  hasDrafts,
}: {
  envelopeId: string
  signers: { name: string; email: string; link: string }[]
  initialMessage: string
  showLinks: boolean
  hasDrafts: boolean
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    signers.length ? signers.map((s, i) => ({ key: i, name: s.name, email: s.email })) : [{ key: 0, name: '', email: '' }],
  )
  const [nextKey, setNextKey] = useState(signers.length + 1)
  const [message, setMessage] = useState(initialMessage)
  const [signerState, saveSigners, savingSigners] = useActionState<EnvelopeActionState, FormData>(saveSignersAction, { status: 'idle' })
  const [sendState, send, sending] = useActionState<EnvelopeActionState, FormData>(sendEnvelopeAction, { status: 'idle' })

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function submitSigners(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(() => saveSigners(fd))
  }

  function submitSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(() => send(fd))
  }

  return (
    <>
      <section className="mt-6 rounded-xl border border-edge bg-paper p-5">
        <h2 className="text-[15px] font-semibold text-ink">Signers</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Saving replaces the recipients on every draft in this envelope. Anyone you remove loses the fields placed for
          them, and those need assigning again.
        </p>
        <form onSubmit={submitSigners} className="mt-3 space-y-2">
          <input type="hidden" name="envelopeId" value={envelopeId} />
          {rows.map((r, i) => (
            <div key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="w-6 shrink-0 text-[12px] text-muted">{i + 1}.</span>
              <input
                name="signerName"
                aria-label={`Signer ${i + 1} name`}
                value={r.name}
                onChange={(e) => update(r.key, { name: e.target.value })}
                placeholder="Name"
                className={fieldClass}
              />
              <input
                name="signerEmail"
                type="email"
                aria-label={`Signer ${i + 1} email`}
                value={r.email}
                onChange={(e) => update(r.key, { email: e.target.value })}
                placeholder="email@example.com"
                className={fieldClass}
              />
              <button
                type="button"
                onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs))}
                className="shrink-0 text-[13px] font-medium text-muted hover:text-danger"
                aria-label={`Remove signer ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setRows((rs) => [...rs, { key: nextKey, name: '', email: '' }])
                setNextKey((k) => k + 1)
              }}
              className="rounded-lg border border-edge-strong px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-shell"
            >
              Add signer
            </button>
            <button
              type="submit"
              disabled={savingSigners}
              className="rounded-lg bg-brand-primary px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-primary-dark disabled:opacity-60"
            >
              {savingSigners ? 'Saving…' : 'Save signers'}
            </button>
          </div>
          <div role="status" className="text-[13px]">
            {signerState.status === 'error' && <p className="text-danger">{signerState.message}</p>}
            {signerState.status === 'signers-saved' && (
              <div className="text-ink">
                <p>Signers saved.</p>
                {signerState.unassigned.length > 0 && (
                  <p className="border-l-2 border-warn pl-2 text-ink">
                    Fields lost their signer in: {signerState.unassigned.map((u) => `${u.name} (${u.fields})`).join(', ')}. Open
                    those documents to assign them again.
                  </p>
                )}
                {signerState.skipped.length > 0 && (
                  <p className="text-muted">Already sent, so unchanged: {signerState.skipped.join(', ')}.</p>
                )}
              </div>
            )}
          </div>
        </form>
      </section>

      {hasDrafts && (
        <section className="mt-6 rounded-xl border border-edge bg-paper p-5">
          <h2 className="text-[15px] font-semibold text-ink">Send</h2>
          <form onSubmit={submitSend} className="mt-3 space-y-3">
            <input type="hidden" name="envelopeId" value={envelopeId} />
            <div>
              <label htmlFor="env-message" className="mb-1.5 block text-[13px] font-medium text-ink">
                Invitation message
              </label>
              <textarea
                id="env-message"
                name="message"
                rows={4}
                maxLength={MAX_INVITE_MESSAGE}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className={fieldClass}
              />
              <p className="mt-1 text-[12px] text-muted">Each signer gets one email listing their documents. Clear this to send no note.</p>
            </div>
            <button
              type="submit"
              disabled={sending}
              className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-primary-dark disabled:opacity-60"
            >
              {sending ? 'Sending…' : 'Send envelope'}
            </button>
            <div role="status" className="text-[13px]">
              {sendState.status === 'error' && <p className="text-danger">{sendState.message}</p>}
              {sendState.status === 'sent' && (
                <div className="space-y-1 text-ink">
                  <p>
                    {sendState.sent.length
                      ? `Sent: ${sendState.sent.join(', ')}.`
                      : 'Nothing was sent — no document was ready.'}
                  </p>
                  {sendState.skipped.length > 0 && (
                    <p className="border-l-2 border-warn pl-2 text-ink">
                      Not sent: {sendState.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.
                    </p>
                  )}
                  {sendState.emailed.some((e) => !e.sent) && (
                    <p className="border-l-2 border-warn pl-2 text-ink">
                      The email to {sendState.emailed.filter((e) => !e.sent).map((e) => e.email).join(', ')} could not be sent — share
                      their link below instead.
                    </p>
                  )}
                </div>
              )}
            </div>
          </form>
        </section>
      )}

      {showLinks && signers.length > 0 && (
        <section className="mt-6 rounded-xl border border-edge bg-paper p-5">
          <h2 className="text-[15px] font-semibold text-ink">Signer links</h2>
          <p className="mt-0.5 text-[13px] text-muted">One link per person, listing every document they need to sign.</p>
          <ul className="mt-3 space-y-2">
            {signers.map((s) => (
              <li key={s.email} className="text-[13px]">
                <span className="font-medium text-ink">{s.name}</span> <span className="text-muted">{s.email}</span>
                <input
                  readOnly
                  value={s.link}
                  aria-label={`Signing link for ${s.name}`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-1 w-full rounded-lg border border-edge bg-shell px-2.5 py-1.5 font-mono text-[12px] text-ink"
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
