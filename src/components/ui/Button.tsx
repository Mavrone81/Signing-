import * as React from "react";

// Adapted from VirtualOffice's `components/ui/button.tsx`, themed to the
// Bevora palette in `src/app/globals.css` and re-implemented without the
// `@radix-ui/react-slot` dependency (not installed in this app). Non-button
// elements (e.g. `<Link>`, `<a download>`) that need the same visual style
// should use `buttonClasses()` directly rather than `asChild`.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand-primary text-white hover:bg-brand-primary-dark",
  secondary: "bg-paper text-ink border border-edge-strong hover:bg-shell",
  ghost: "text-brand-primary hover:bg-brand-primary-tint",
  danger: "bg-danger text-white hover:opacity-90",
};

// Both sizes keep a 44px minimum touch target (mobile a11y requirement);
// they differ only in horizontal padding and type size.
const sizes: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 text-[13px]",
  md: "min-h-11 px-4 text-sm",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className = ""
) {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`;
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "primary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={buttonClasses(variant, size, className)}
      {...props}
    />
  )
);
Button.displayName = "Button";
