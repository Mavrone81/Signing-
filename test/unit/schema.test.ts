import { describe, it, expect } from 'vitest'
import { Role, DocStatus, FieldType, AuditAction, RecipientStatus, SigningOrder } from '@prisma/client'
import { prisma } from '../../src/lib/db'

describe('prisma schema', () => {
  it('generates a client with the expected models', () => {
    expect(prisma.user).toBeDefined()
    expect(prisma.document).toBeDefined()
    expect(prisma.field).toBeDefined()
    expect(prisma.auditEvent).toBeDefined()
    expect(prisma.recipient).toBeDefined()
  })

  it('exposes the Role enum', () => {
    expect(Role.admin).toBe('admin')
    expect(Role.user).toBe('user')
  })

  it('exposes the DocStatus enum', () => {
    expect(DocStatus.draft).toBe('draft')
    expect(DocStatus.signed).toBe('signed')
    expect(DocStatus.sent).toBe('sent')
    expect(DocStatus.completed).toBe('completed')
    expect(DocStatus.declined).toBe('declined')
  })

  it('exposes the send-for-signature enums', () => {
    expect(SigningOrder.parallel).toBe('parallel')
    expect(SigningOrder.sequential).toBe('sequential')
    expect(RecipientStatus.pending).toBe('pending')
    expect(RecipientStatus.viewed).toBe('viewed')
    expect(RecipientStatus.signed).toBe('signed')
    expect(RecipientStatus.declined).toBe('declined')
  })

  it('exposes the FieldType enum', () => {
    expect(FieldType.signature).toBe('signature')
    expect(FieldType.date).toBe('date')
    expect(FieldType.text).toBe('text')
    // Phase 4a
    expect(FieldType.checkbox).toBe('checkbox')
    expect(FieldType.initials).toBe('initials')
    expect(FieldType.radio).toBe('radio')
    expect(FieldType.dropdown).toBe('dropdown')
  })

  it('exposes the AuditAction enum', () => {
    expect(AuditAction.upload).toBe('upload')
    expect(AuditAction.finalize).toBe('finalize')
    expect(AuditAction.download).toBe('download')
    expect(AuditAction.reset).toBe('reset')
    expect(AuditAction.send).toBe('send')
    expect(AuditAction.sign).toBe('sign')
    expect(AuditAction.decline).toBe('decline')
  })
})
