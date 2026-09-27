"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RequirePermission } from "@/components/RequirePermission";
import { PageHeader, TabPanel, Tabs } from "@/components/ui";
import { OrgTab } from "@/components/admin/OrgTab";
import { UsersTab } from "@/components/admin/UsersTab";
import { ProjectsTab } from "@/components/admin/ProjectsTab";
import { SsoTab } from "@/components/admin/SsoTab";
import { ApiKeysTab } from "@/components/admin/ApiKeysTab";
import { LlmTab } from "@/components/admin/LlmTab";
import { UsageTab } from "@/components/admin/UsageTab";
import { AuditTab } from "@/components/admin/AuditTab";
import { WebhooksTab } from "@/components/admin/WebhooksTab";
import { DataTab } from "@/components/admin/DataTab";
import { LlmHealthTab } from "@/components/admin/LlmHealthTab";
import { PromptsTab } from "@/components/admin/PromptsTab";
import { NetworkTab, OAuthClientsTab, ScimTab, TeamsTab } from "@/components/admin/AccessTabs";
import { ConsentTab, CostsTab, SharingTab } from "@/components/admin/GovernanceTabs";
import { ChatDestinationsTab, InboundHooksTab } from "@/components/admin/IntegrationTabs";
import { PreferencesCard } from "@/components/analytics/SuggestionFeedback";

const GROUPS: { group: string; tabs: { id: string; label: string }[] }[] = [
  {
    group: "Organization",
    tabs: [
      { id: "org", label: "Organization" },
      { id: "users", label: "Users" },
      { id: "teams", label: "Teams" },
      { id: "projects", label: "Projects" },
    ],
  },
  {
    group: "Access & security",
    tabs: [
      { id: "sso", label: "SSO" },
      { id: "scim", label: "SCIM" },
      { id: "keys", label: "API keys" },
      { id: "oauth", label: "OAuth clients" },
      { id: "network", label: "Network policy" },
      { id: "sharing", label: "Sharing" },
    ],
  },
  {
    group: "AI",
    tabs: [
      { id: "llm", label: "LLM provider" },
      { id: "llm-health", label: "LLM health" },
      { id: "prompts", label: "Prompts" },
      { id: "consent", label: "Consent" },
      { id: "preferences", label: "Suggestion preferences" },
    ],
  },
  {
    group: "Integrations",
    tabs: [
      { id: "webhooks", label: "Webhooks" },
      { id: "inbound", label: "Incoming webhooks" },
      { id: "chat", label: "Slack / Teams" },
    ],
  },
  {
    group: "Usage & compliance",
    tabs: [
      { id: "usage", label: "Usage" },
      { id: "costs", label: "Costs" },
      { id: "audit", label: "Audit log" },
      { id: "data", label: "Data & deletion" },
    ],
  },
];

const ALL_TABS = GROUPS.flatMap((g) => g.tabs);

/** Tenant admin console (MT-008). */
export default function AdminPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = ALL_TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "org";
  const group = GROUPS.find((g) => g.tabs.some((t) => t.id === tab)) ?? GROUPS[0];
  const go = (t: string) => router.replace(`${pathname}?tab=${t}`, { scroll: false });
  return (
    <RequirePermission perm="tenant.manage">
      <PageHeader
        title="Admin"
        description="Organization, access and security, AI providers and prompts, integrations, usage, costs and data lifecycle."
      />
      <nav aria-label="Admin sections" className="mb-3 flex flex-wrap gap-1">
        {GROUPS.map((g) => (
          <button
            key={g.group}
            type="button"
            aria-current={g.group === group.group ? "true" : undefined}
            onClick={() => go(g.tabs[0].id)}
            className={`rounded-full px-3 py-1 text-xs ${g.group === group.group ? "bg-brand-600 text-white" : "bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)]"}`}
          >
            {g.group}
          </button>
        ))}
      </nav>
      <Tabs label={`${group.group} settings`} tabs={group.tabs} active={tab} onChange={go} />
      <TabPanel id={tab}>
        {tab === "org" && <OrgTab />}
        {tab === "users" && <UsersTab />}
        {tab === "teams" && <TeamsTab />}
        {tab === "projects" && <ProjectsTab />}
        {tab === "sso" && <SsoTab />}
        {tab === "scim" && <ScimTab />}
        {tab === "keys" && <ApiKeysTab />}
        {tab === "oauth" && <OAuthClientsTab />}
        {tab === "network" && <NetworkTab />}
        {tab === "sharing" && <SharingTab />}
        {tab === "llm" && <LlmTab />}
        {tab === "llm-health" && <LlmHealthTab />}
        {tab === "prompts" && <PromptsTab />}
        {tab === "consent" && <ConsentTab />}
        {tab === "preferences" && <PreferencesCard />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "inbound" && <InboundHooksTab />}
        {tab === "chat" && <ChatDestinationsTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "costs" && <CostsTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "data" && <DataTab />}
      </TabPanel>
    </RequirePermission>
  );
}
