// Renders a Date/ISO-string in Singapore local time regardless of host TZ,
// so display is consistent whether this runs on a dev laptop or the deploy
// box.
export function formatDateSGT(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  }).format(d);
}
