export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-md bg-brand-600 font-bold text-white">
            A
          </span>
          <span className="font-semibold">Analytics Platform</span>
        </div>
        <h1 className="mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
