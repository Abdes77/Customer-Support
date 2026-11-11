export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Home-services reply bot</h1>
      <p className="text-slate-600">
        The repository is scaffolded. The admin panel, channels and the conversation engine are
        added by later build chunks; see docs/BUILD_PLAN.md.
      </p>
      <p>
        <a className="text-blue-700 underline" href="/api/health">
          Health check
        </a>
      </p>
    </main>
  );
}
