function Skeleton({ className }: { className?: string }) {
  return <div className={`bg-gray-100 rounded animate-pulse ${className}`} />
}

export default function Loading() {
  return (
    <div>
      <div className="pt-10 pb-8 border-b border-gray-100">
        <Skeleton className="h-3 w-36 mb-3" />
        <Skeleton className="h-8 w-64 mb-3" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid grid-cols-3 gap-6 py-8 border-b border-gray-100">
        {[...Array(3)].map((_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-28 mb-2" />
            <Skeleton className="h-8 w-32" />
          </div>
        ))}
      </div>
      <div className="mt-8 space-y-2">
        {[...Array(10)].map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  )
}
