import type { Role, OrgRole } from '@prisma/client'
import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
      role: Role
      // The user's active organization (their first/only Membership for now).
      // null when the user has no membership — they can't access any document.
      orgId: string | null
      orgRole: OrgRole | null
      // Deployment-wide "IT admin" who manages the SSO/OAuth keys in Settings.
      isPlatformAdmin: boolean
    }
  }
  interface User {
    role: Role
    isPlatformAdmin?: boolean
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role: Role
    orgId: string | null
    orgRole: OrgRole | null
    isPlatformAdmin: boolean
  }
}
