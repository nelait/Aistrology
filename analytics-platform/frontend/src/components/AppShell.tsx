"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/rbac";
import { useTheme } from "@/lib/theme";
import type { PermissionName } from "@/lib/types";
import { NotificationBell } from "./NotificationBell";
import { Spinner, cx } from "./ui";

interface NavItem {
  href: string;
  label: string;
  perm: PermissionName;
  icon: string;
}

export const NAV: NavItem[] = [
  { href: "/datasets", label: "Datasets", perm: "data.read", icon: "M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zm0 0v12c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12c0 1.1 3.6 2 8 2s8-.9 8-2" },
  { href: "/generate", label: "Sample data", perm: "data.write", icon: "M12 3v18M3 12h18" },
  { href: "/pipelines", label: "Pipelines", perm: "data.read", icon: "M4 6h16M4 12h10M4 18h6" },
  { href: "/analytics", label: "Analytics", perm: "view", icon: "M4 20V10m6 10V4m6 16v-7m4 7H2" },
  { href: "/experiments", label: "Experiments", perm: "data.read", icon: "M9 3v6L4 19a1 1 0 001 1h14a1 1 0 001-1l-5-10V3M8 3h8" },
  { href: "/models", label: "Models", perm: "data.read", icon: "M12 2l9 5v10l-9 5-9-5V7z" },
  { href: "/endpoints", label: "Endpoints", perm: "data.read", icon: "M5 12h14M12 5l7 7-7 7" },
  { href: "/dashboards", label: "Dashboards", perm: "view", icon: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z" },
  { href: "/jobs", label: "Jobs", perm: "data.read", icon: "M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { href: "/admin", label: "Admin", perm: "tenant.manage", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15H3a2 2 0 110-4h.1a1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 009 4.6V4a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, can, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  const items = NAV.filter((n) => can(n.perm));

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="skip-link rounded bg-brand-600 px-3 py-2 text-white">
        Skip to content
      </a>
      <aside
        id="sidebar"
        className={cx(
          "no-print fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform lg:static lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-[var(--border)] px-4">
          <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white">
            A
          </span>
          <span className="font-semibold">Analytics</span>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {items.map((n) => {
              const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                      active ? "bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-100" : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                    )}
                  >
                    <Icon d={n.icon} />
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-2)]">
          Org: <span className="font-mono">{me?.tenant_id}</span>
        </p>
      </aside>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 lg:px-6">
          <button
            type="button"
            className="rounded-md p-2 hover:bg-[var(--surface-2)] lg:hidden"
            aria-label="Toggle navigation"
            aria-controls="sidebar"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            <Icon d="M4 6h16M4 12h16M4 18h16" />
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={toggle}
            className="rounded-md p-2 hover:bg-[var(--surface-2)]"
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            aria-pressed={dark}
          >
            {dark ? <Icon d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.4 6.4l-.7-.7M6.3 6.3l-.7-.7m12.8 0l-.7.7M6.3 17.7l-.7.7M16 12a4 4 0 11-8 0 4 4 0 018 0z" /> : <Icon d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />}
          </button>
          <NotificationBell />
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--surface-2)]"
            >
              <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800 dark:bg-brand-800 dark:text-brand-50">
                {(me?.name || me?.email || "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden text-left sm:block">
                <span className="block max-w-40 truncate leading-tight">{me?.name || me?.email}</span>
                <span className="block text-xs leading-tight text-[var(--text-2)]">{me ? ROLE_LABELS[me.role] ?? me.role : ""}</span>
              </span>
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 z-50 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl" onKeyDown={(e) => e.key === "Escape" && setMenuOpen(false)}>
                <Link role="menuitem" href="/settings/mfa" className="block rounded px-3 py-2 text-sm hover:bg-[var(--surface-2)]">
                  Two-factor authentication {me?.mfa_enabled ? "✓" : ""}
                </Link>
                <button role="menuitem" type="button" onClick={() => logout()} className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]">
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="print-full min-w-0 flex-1 p-4 outline-none lg:p-6">
          <Suspense fallback={<Spinner />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}
