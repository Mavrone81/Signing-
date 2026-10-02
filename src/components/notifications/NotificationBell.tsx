"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  markNotificationRead,
  markAllNotificationsRead,
  type NotificationView,
} from "@/server/notifications/actions";

// Rendered in the authed app shell's header, on EVERY page — not a field on
// a settings page nobody routinely opens (Sign #11: that was F1's own
// earlier mistake, corrected). An admin with an expiring certificate sees
// the badge the moment they land on /documents, which is the page they
// actually visit.
export function NotificationBell({
  unreadCount,
  recent,
}: {
  unreadCount: number;
  recent: NotificationView[];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink transition-colors hover:bg-shell"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-outside catcher */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 max-w-[90vw] rounded-xl border border-edge bg-paper shadow-lg">
            <div className="flex items-center justify-between border-b border-edge px-3 py-2">
              <span className="text-[13px] font-semibold text-ink">Notifications</span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      await markAllNotificationsRead();
                    })
                  }
                  className="text-[12px] font-medium text-brand-primary hover:underline disabled:opacity-50"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {recent.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted">No notifications yet.</p>
              ) : (
                <ul>
                  {recent.map((n) => {
                    const unread = !n.readAt;
                    const content = (
                      <div
                        className={`border-b border-edge px-3 py-2.5 text-[13px] ${unread ? "bg-shell" : ""}`}
                      >
                        <div className="flex items-start gap-2">
                          {unread && (
                            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" aria-hidden />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium text-ink">{n.title}</p>
                            <p className="mt-0.5 text-[12px] text-muted">{n.body}</p>
                          </div>
                        </div>
                      </div>
                    );
                    return (
                      <li key={n.id}>
                        {n.href ? (
                          <Link
                            href={n.href}
                            onClick={() => {
                              if (unread) startTransition(() => markNotificationRead(n.id));
                              setOpen(false);
                            }}
                            className="block hover:bg-shell/60"
                          >
                            {content}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => unread && startTransition(() => markNotificationRead(n.id))}
                            className="block w-full text-left hover:bg-shell/60"
                          >
                            {content}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
