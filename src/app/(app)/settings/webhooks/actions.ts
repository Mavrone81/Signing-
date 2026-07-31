'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import {
  createWebhook,
  updateWebhook,
  deleteWebhook,
  type WebhookActor,
} from '@/server/webhooks/actions'

export type WebhookFormState = { status: 'idle' } | { status: 'ok' } | { status: 'error'; message: string }

async function actor(): Promise<WebhookActor> {
  const session = await auth()
  return {
    orgId: session?.user?.orgId ?? null,
    orgRole: session?.user?.orgRole ?? null,
    userId: session?.user?.id ?? '',
  }
}

function errorMessage(error: string): string {
  if (error === 'INVALID_URL') return 'Enter a valid public https:// URL (internal addresses are not allowed).'
  if (error === 'INVALID_EVENTS') return 'Select at least one event.'
  if (error === 'NOT_FOUND') return 'That endpoint no longer exists.'
  return 'You do not have permission.'
}

export async function createWebhookAction(_prev: WebhookFormState, formData: FormData): Promise<WebhookFormState> {
  const url = String(formData.get('url') ?? '')
  const events = formData.getAll('events').map(String)
  const res = await createWebhook(await actor(), url, events)
  if (!res.ok) return { status: 'error', message: errorMessage(res.error) }
  revalidatePath('/settings/webhooks')
  return { status: 'ok' }
}

export async function toggleWebhookAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const enabled = String(formData.get('enabled') ?? '') === '1'
  await updateWebhook(await actor(), id, { enabled })
  revalidatePath('/settings/webhooks')
}

export async function deleteWebhookAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  await deleteWebhook(await actor(), id)
  revalidatePath('/settings/webhooks')
}
