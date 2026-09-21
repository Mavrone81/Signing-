import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { listMembers } from '@/server/team/actions'
import { isEmailConfigured } from '@/lib/mailer'
import { TeamManager } from './TeamManager'
import { PageHeader } from '@/components/ui/PageHeader'

export const metadata: Metadata = { title: 'Team · Settings · Bevora Sign' }

// Org owner/admin only — team management is per-org, self-service (same gate as
// Branding / API keys). A plain member (or no membership) gets a 404 (no hint
// the page exists). NOT a platform-admin gate: every org's admin manages its own
// members, strictly scoped to session.user.orgId.
export default async function TeamSettingsPage() {
  const session = await auth()
  const role = session?.user?.orgRole
  const orgId = session?.user?.orgId
  if (!orgId || (role !== 'owner' && role !== 'admin')) notFound()

  const [members, emailConfigured] = await Promise.all([listMembers(orgId), isEmailConfigured(orgId)])

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Team"
        backHref="/documents"
        subtitle={
          <>
            Add and manage the people in your organization. Owners and admins can add users — added users get document
            and signing access (Member); only an owner can change an existing member&apos;s role.
          </>
        }
      />

      <TeamManager
        members={members}
        isOwner={role === 'owner'}
        currentUserId={session.user.id}
        emailConfigured={emailConfigured}
      />
    </div>
  )
}
