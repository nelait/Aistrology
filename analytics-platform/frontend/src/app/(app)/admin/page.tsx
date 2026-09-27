"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RequirePermission } from "@/components/RequirePermission";
import { PageHeader, TabPanel, Tabs } from "@/components/ui";
import { OrgTab } from "@/components/admin/OrgTab";
import { UsersTab } from "@/components/admin/UsersTab";
import { ApiKeysTab } from "@/components/admin/ApiKeysTab";
import { LlmTab } from "@/components/admin/LlmTab";
import { UsageTab } from "@/components/admin/UsageTab";
import { AuditTab } from "@/components/admin/AuditTab";
import { WebhooksTab } from "@/components/admin/WebhooksTab";
import { DataTab } from "@/components/admin/DataTab";

const TABS = [
  { id: "org", label: "Organization" },
  { id: "users", label: "Users" },
  { id: "keys", label: "API keys" },
  { id: "llm", label: "LLM provider" },
  { id: "usage", label: "Usage" },
  { id: "audit", label: "Audit log" },
  { id: "webhooks", label: "Webhooks" },
  { id: "data", label: "Data & deletion" },
];

/** Tenant admin console (MT-008). */
export default function AdminPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "org";
  return (
    <RequirePermission perm="tenant.manage">
      <PageHeader title="Admin" description="Organization settings, users, API keys, LLM provider, usage, audit log and data lifecycle." />
      <Tabs label="Admin sections" tabs={TABS} active={tab} onChange={(t) => router.replace(`${pathname}?tab=${t}`, { scroll: false })} />
      <TabPanel id={tab}>
        {tab === "org" && <OrgTab />}
        {tab === "users" && <UsersTab />}
        {tab === "keys" && <ApiKeysTab />}
        {tab === "llm" && <LlmTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "data" && <DataTab />}
      </TabPanel>
    </RequirePermission>
  );
}
