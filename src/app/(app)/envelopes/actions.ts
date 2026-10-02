'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { env } from '@/env'
import {
  createEnvelope,
  addDocuments,
  removeDocument,
  setSigners,
  sendEnvelope,
  type EnvelopeActor,
} from '@/server/envelopes/actions'

// The actor is ALWAYS taken from the session, never from the form.
async function actor(): Promise<EnvelopeActor> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  return { id: session.user.id, orgId: session.user.orgId ?? null, orgRole: session.user.orgRole ?? null }
}

async function requestMeta() {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'http'
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    // Signers' links must be absolute in the email.
    baseUrl: (env.AUTH_URL ?? (host ? `${proto}://${host}` : '')).replace(/\/+$/, ''),
  }
}

export type CreateEnvelopeState = { status: 'idle' } | { status: 'error'; message: string }

export async function createEnvelopeAction(_prev: CreateEnvelopeState, formData: FormData): Promise<CreateEnvelopeState> {
  const res = await createEnvelope(await actor(), {
    name: String(formData.get('name') ?? ''),
    documentIds: formData.getAll('documentId').map(String),
  })
  if (!res.ok) {
    const message =
      res.error === 'INVALID'
        ? 'Give the envelope a name.'
        : res.error === 'NO_ORGANIZATION'
          ? 'You need to belong to an organization to create envelopes.'
          : 'One of those documents is no longer available to add. Refresh and try again.'
    return { status: 'error', message }
  }
  revalidatePath('/envelopes')
  redirect(`/envelopes/${res.id}`)
}

export type EnvelopeActionState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'signers-saved'; unassigned: { name: string; fields: number }[]; skipped: string[] }
  | {
      status: 'sent'
      sent: string[]
      skipped: { name: string; reason: string }[]
      emailed: { email: string; sent: boolean }[]
    }

const SKIP_REASON: Record<string, string> = {
  NO_RECIPIENTS: 'it has no signers',
  RECIPIENT_WITHOUT_FIELD: 'a signer has no field to fill in',
}

export async function saveSignersAction(_prev: EnvelopeActionState, formData: FormData): Promise<EnvelopeActionState> {
  const envelopeId = String(formData.get('envelopeId') ?? '')
  const names = formData.getAll('signerName').map(String)
  const emails = formData.getAll('signerEmail').map(String)
  const rows = names.map((name, i) => ({ name, email: emails[i] ?? '' }))
  const res = await setSigners(await actor(), envelopeId, rows)
  revalidatePath(`/envelopes/${envelopeId}`)
  if (!res.ok) {
    return {
      status: 'error',
      message: res.error === 'INVALID' ? 'Each signer needs a name and a valid email.' : 'That envelope is no longer available.',
    }
  }
  return {
    status: 'signers-saved',
    unassigned: res.unassigned.map((u) => ({ name: u.name, fields: u.fields })),
    skipped: res.skipped.map((s) => s.name),
  }
}

export async function sendEnvelopeAction(_prev: EnvelopeActionState, formData: FormData): Promise<EnvelopeActionState> {
  const envelopeId = String(formData.get('envelopeId') ?? '')
  const res = await sendEnvelope(await actor(), envelopeId, {
    message: String(formData.get('message') ?? ''),
    meta: await requestMeta(),
  })
  revalidatePath(`/envelopes/${envelopeId}`)
  revalidatePath('/envelopes')
  if (!res.ok) {
    return {
      status: 'error',
      message: res.error === 'NO_SIGNERS' ? 'Add at least one signer first.' : 'That envelope is no longer available.',
    }
  }
  return {
    status: 'sent',
    sent: res.sent.map((d) => d.name),
    skipped: res.skipped.map((s) => ({ name: s.name, reason: SKIP_REASON[s.reason] ?? 'it could not be sent' })),
    emailed: res.emailed,
  }
}

export async function addDocumentsAction(formData: FormData): Promise<void> {
  const envelopeId = String(formData.get('envelopeId') ?? '')
  await addDocuments(await actor(), envelopeId, formData.getAll('documentId').map(String))
  revalidatePath(`/envelopes/${envelopeId}`)
}

export async function removeDocumentAction(formData: FormData): Promise<void> {
  const envelopeId = String(formData.get('envelopeId') ?? '')
  await removeDocument(await actor(), envelopeId, String(formData.get('documentId') ?? ''))
  revalidatePath(`/envelopes/${envelopeId}`)
}
