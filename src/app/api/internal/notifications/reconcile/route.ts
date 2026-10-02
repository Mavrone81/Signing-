import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env'
import { reconcileCertExpiryNotifications } from '@/server/notifications/cert-expiry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/internal/notifications/reconcile — run one reconciliation pass
// over every org's certificate-expiry state. Designed to be called
// REPEATEDLY (hourly is plenty — the thresholds are day-granularity) by an
// external scheduler (the box's existing crontab, same pattern as
// deploy/auto-deploy-bevorasign.sh), NOT a fire-once job: see
// cert-expiry.ts's header for why a reconciliation run has to be safe to
// call as often as the operator likes, including twice at once.
//
// Auth: a shared secret header, not a session — this is a machine-to-machine
// endpoint with no human in the loop. Refuses every request (503, not a
// silent no-op) until CRON_SECRET is actually set, so a missing secret in
// deploy config is loud, not a job that quietly never ran.
export async function POST(req: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET_NOT_CONFIGURED' }, { status: 503 })
  }
  const provided = req.headers.get('x-cron-secret')
  if (provided !== env.CRON_SECRET) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const result = await reconcileCertExpiryNotifications()
  return NextResponse.json(result, { status: 200 })
}
