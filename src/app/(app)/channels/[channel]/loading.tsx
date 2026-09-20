export default function LoadingChannel() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-7xl animate-pulse space-y-6">
        <div className="h-7 w-40 rounded bg-secondary" />
        <div className="h-4 w-72 rounded bg-secondary" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-secondary" />
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 rounded-xl bg-secondary" />
          ))}
        </div>
      </div>
    </div>
  );
}
