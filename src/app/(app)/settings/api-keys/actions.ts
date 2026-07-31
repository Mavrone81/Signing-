'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { createApiKey, revokeApiKey, type ApiKeyActor } from '@/server/api-keys/actions'

// The raw key is surfaced ONCE via this action's return value (held in the
// client component's state), never persisted or put in a URL.
export type CreateKeyState =
  | { status: 'idle' }
  | { status: 'created'; raw: string; prefix: string; name: string }
  | { status: 'error'; message: string }

async function actor(): Promise<ApiKeyActor> {
  const session = await auth()
  return {
    orgId: session?.user?.orgId ?? null,
    orgRole: session?.user?.orgRole ?? null,
    userId: session?.user?.id ?? '',
  }
}

export async function createKeyAction(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const name = String(formData.get('name') ?? '')
  const res = await createApiKey(await actor(), name)
  if (!res.ok) {
    return {
      status: 'error',
      message: res.error === 'INVALID_NAME' ? 'Enter a name for the key.' : 'You do not have permission.',
    }
  }
  revalidatePath('/settings/api-keys')
  return { status: 'created', raw: res.raw, prefix: res.key.prefix, name: res.key.name }
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  await revokeApiKey(await actor(), id)
  revalidatePath('/settings/api-keys')
}
