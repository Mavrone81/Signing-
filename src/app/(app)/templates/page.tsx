import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { PageHeader } from '@/components/ui/PageHeader'
import { TemplateList, type TemplateSummary } from '@/components/templates/TemplateList'
import { listTemplates } from '@/server/templates/actions'

export const metadata: Metadata = { title: 'Templates · Bevora Sign' }

// Queries Prisma directly in the server component → must be force-dynamic so
// `next build` doesn't try to prerender it with no DB available.
export const dynamic = 'force-dynamic'

export default async function TemplatesPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const actor = {
    id: session.user.id,
    orgId: session.user.orgId,
    orgRole: session.user.orgRole,
  }
  const rows = await listTemplates(actor)

  // A template can be deleted by its creator or any org owner/admin.
  const isOrgAdmin = session.user.orgRole === 'owner' || session.user.orgRole === 'admin'
  const templates: TemplateSummary[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    pageCount: t.pageCount,
    fieldCount: t._count.templateFields,
    roleCount: t._count.templateRoles,
    createdAt: t.createdAt.toISOString(),
    canDelete: isOrgAdmin || t.createdById === session.user.id,
  }))

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Templates"
        subtitle="Reusable document layouts. Use one to start a new document with its fields and recipients pre-placed."
      />
      <TemplateList templates={templates} />
    </div>
  )
}
