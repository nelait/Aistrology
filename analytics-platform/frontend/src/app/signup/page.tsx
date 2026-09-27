"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import { Button, SelectField, TextField } from "@/components/ui";

/** Self-service onboarding (MT-005): sign up → organization → first dataset. */
export default function SignupPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ org_name: "", tenant_id: "", name: "", email: "", password: "", confirm: "", region: "us" as "us" | "eu" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.org_name.trim()) e.org_name = "Organization name is required";
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(form.tenant_id)) e.tenant_id = "3–63 lowercase letters, digits or dashes";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email";
    if (form.password.length < 12) e.password = "At least 12 characters";
    if (form.password !== form.confirm) e.confirm = "Passwords don't match";
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.signup({ tenant_id: form.tenant_id, org_name: form.org_name, email: form.email, password: form.password, name: form.name || undefined, region: form.region });
      await login({ email: form.email, password: form.password });
      router.replace("/datasets?welcome=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Create your organization">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <TextField
          label="Organization name"
          required
          value={form.org_name}
          error={errors.org_name}
          onChange={(e) => {
            set("org_name", e.target.value);
            if (!slugTouched) set("tenant_id", slugify(e.target.value));
          }}
        />
        <TextField
          label="Organization ID"
          hint="Used in URLs and API calls; can't be changed later."
          required
          value={form.tenant_id}
          error={errors.tenant_id}
          onChange={(e) => {
            setSlugTouched(true);
            set("tenant_id", slugify(e.target.value));
          }}
        />
        <SelectField
          label="Data region"
          hint="Where your data is stored (SEC-002). Can't be changed later."
          value={form.region}
          onChange={(e) => set("region", e.target.value as "us" | "eu")}
          options={[
            { value: "us", label: "United States" },
            { value: "eu", label: "European Union" },
          ]}
        />
        <TextField label="Your name" autoComplete="name" value={form.name} onChange={(e) => set("name", e.target.value)} />
        <TextField label="Work email" type="email" autoComplete="email" required value={form.email} error={errors.email} onChange={(e) => set("email", e.target.value)} />
        <TextField label="Password" type="password" autoComplete="new-password" required hint="At least 12 characters." value={form.password} error={errors.password} onChange={(e) => set("password", e.target.value)} />
        <TextField label="Confirm password" type="password" autoComplete="new-password" required value={form.confirm} error={errors.confirm} onChange={(e) => set("confirm", e.target.value)} />
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create organization
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-[var(--text-2)]">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-600 underline dark:text-brand-300">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
